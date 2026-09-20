'use strict';

// 目标路径查询自检（node test/pathquery.js）
// 覆盖：
//   1) findPath 单元：最短路径 / 每步状态 / 真值与假值约束 / 无解时的最接近状态与缺失变量 /
//      目标不可达 / 目标即起点 / 起点被前置挡住 / 目标不存在 / 查询参数校验 / 状态上限截断
//   2) HTTP 集成：POST /api/path-query（草稿）与 POST /api/stories/:id/path-query（已保存）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const { findPath, normalizeQuery } = require('../src/pathquery');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

// ---------- 测试剧情 ----------
// s --o1(置a)--> m --o3(置b)--> t
// s --o2(直达)----------------> t
// x：孤岛场景（无任何入边）
const storyA = {
  title: '查询测试剧情',
  startScene: 's',
  variables: [{ name: 'a' }, { name: 'b' }],
  scenes: [
    {
      id: 's', title: '起点', options: [
        { uid: 'o1', text: '去拿 a', target: 'm', assigns: [{ variable: 'a', value: true }] },
        { uid: 'o2', text: '直接去 t', target: 't' },
      ],
    },
    {
      id: 'm', title: '中途', options: [
        { uid: 'o3', text: '去 t', target: 't', assigns: [{ variable: 'b', value: true }] },
      ],
    },
    { id: 't', title: '终点', options: [] },
    { id: 'x', title: '孤岛', options: [] },
  ],
};

console.log('最短路径与每步状态：');
{
  const r = findPath(storyA, { targetScene: 't' });
  ok('无约束查询命中', r.ok && r.found === true);
  ok('直达最短为 1 步', r.depth === 1);
  ok('路径为 场景-选项-场景 三节点', r.path.length === 3
    && r.path[0].kind === 'scene' && r.path[1].kind === 'option' && r.path[2].kind === 'scene');
  ok('路径起点为 s、终点为 t', r.path[0].sceneId === 's' && r.path[2].sceneId === 't');
  ok('每步都带完整变量状态', r.path[0].state.a === false && r.path[2].state.a === false
    && r.path[2].state.b === false);
  ok('未截断且可断言', r.truncated === false && r.canAssertUnsatisfiable === false);
}

{
  const r = findPath(storyA, { targetScene: 't', constraints: [{ variable: 'a', value: true }] });
  ok('要求 a=true 时绕路 2 步', r.found === true && r.depth === 2);
  ok('路径 5 个节点（3 场景 + 2 选项）', r.path.length === 5);
  ok('中途场景状态 a=true,b=false', r.path[2].sceneId === 'm'
    && r.path[2].state.a === true && r.path[2].state.b === false);
  ok('到达状态满足约束 a=true', r.finalState.a === true && r.finalState.b === true);
}

{
  const r = findPath(storyA, { targetScene: 't', constraints: [{ variable: 'b', value: false }] });
  ok('假值约束：b=false 时直达即可', r.found === true && r.depth === 1 && r.finalState.b === false);
}

{
  // constraints 也接受对象映射形式
  const r = findPath(storyA, { targetScene: 't', constraints: { a: true } });
  ok('constraints 对象映射形式等价', r.found === true && r.depth === 2);
}

{
  const r = findPath(storyA, { targetScene: 's', constraints: [{ variable: 'a', value: false }] });
  ok('目标即起点：0 步命中', r.found === true && r.depth === 0 && r.path.length === 1);
}

console.log('无解时的最接近结果：');
{
  // 唯一能拿到 a=true 的路径同时会把 b 置真 => a=true && b=false 不可满足
  const r = findPath(storyA, {
    targetScene: 't',
    constraints: [{ variable: 'a', value: true }, { variable: 'b', value: false }],
  });
  ok('未命中', r.found === false);
  ok('完整枚举后可断言无解', r.canAssertUnsatisfiable === true && r.truncated === false);
  ok('目标场景本身可达', r.sceneReachable === true);
  ok('给出差异最少的可达状态', !!r.closest && r.closest.depth === 1);
  ok('缺失变量为 a（需 true 实际 false）', r.closest.missing.length === 1
    && r.closest.missing[0].variable === 'a'
    && r.closest.missing[0].want === true && r.closest.missing[0].actual === false);
  ok('最接近状态附带最近路径', Array.isArray(r.closest.path) && r.closest.path.length === 3
    && r.closest.path[2].sceneId === 't');
}

{
  const r = findPath(storyA, { targetScene: 'x' });
  ok('孤岛场景：未命中且场景不可达', r.found === false && r.sceneReachable === false);
  ok('孤岛场景无最接近状态', !r.closest);
}

console.log('边界与参数校验：');
{
  const blocked = {
    startScene: 's', variables: [{ name: 'a' }],
    scenes: [{ id: 's', precondition: 'a', options: [] }],
  };
  const r = findPath(blocked, { targetScene: 's' });
  ok('起点被前置条件挡住', r.ok === true && r.startBlocked === true && r.found === false);
  ok('起点被挡时可断言无解且附未满足解释', r.canAssertUnsatisfiable === true && !!r.unmet);
}
{
  const r = findPath(storyA, { targetScene: 'ghost' });
  ok('目标场景不存在返回 ok:false', r.ok === false && /不存在/.test(r.error));
}
{
  const r = findPath({ scenes: storyA.scenes }, { targetScene: 't' });
  ok('未指定起点返回 ok:false', r.ok === false && /起点/.test(r.error));
}
{
  assert.throws(() => normalizeQuery({}), (e) => e.status === 400 && /目标场景/.test(e.message));
  ok('缺少目标场景抛出 400', true);
  assert.throws(
    () => normalizeQuery({ targetScene: 't', constraints: [{ variable: 'a', value: true }, { variable: 'a', value: false }] }),
    (e) => e.status === 400 && /约束冲突/.test(e.message),
  );
  ok('同一变量真/假冲突抛出 400', true);
  const nq = normalizeQuery({ targetScene: ' t ', constraints: [{ variable: 'a', value: 'false' }] });
  ok('查询参数被规整（去空格、字符串布尔）', nq.targetScene === 't'
    && nq.constraints[0].value === false);
}

console.log('状态上限截断：');
{
  // 4 个独立开关的自循环：完整状态空间 2^4=16；用小上限强制截断
  const bits = {
    startScene: 's',
    variables: [{ name: 'v1' }, { name: 'v2' }, { name: 'v3' }, { name: 'v4' }],
    scenes: [{
      id: 's',
      options: ['v1', 'v2', 'v3', 'v4'].map((v, i) => ({
        uid: `f${i}`, text: `置 ${v}`, target: 's', assigns: [{ variable: v, value: true }],
      })),
    }],
  };
  const query = {
    targetScene: 's',
    constraints: ['v1', 'v2', 'v3', 'v4'].map((v) => ({ variable: v, value: true })),
  };
  const small = findPath(bits, query, { maxStates: 5 });
  ok('小上限下搜索被截断', small.truncated === true && small.found === false);
  ok('截断时不能断言无解', small.canAssertUnsatisfiable === false);
  ok('截断结果仍给出已探索部分的最接近状态', !!small.closest
    && small.closest.missing.length === 2 && small.closest.path.length >= 1);
  const full = findPath(bits, query);
  ok('默认上限下同一查询可解（4 步）', full.found === true && full.depth === 4);
}

console.log('示例剧情（含环路）上的查询：');
{
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
  const r = findPath(demo, { targetScene: 'throneRoom', constraints: [{ variable: 'hasKey', value: true }] });
  ok('含环路剧情查询正常终止并命中', r.found === true);
  ok('最短链需先取钥匙（5 步）', r.depth === 5);
  ok('到达状态满足 hasKey=true', r.finalState.hasKey === true);
  const d = findPath(demo, { targetScene: 'dungeon' });
  ok('不可达场景（地下地牢）查询报告场景不可达', d.found === false && d.sceneReachable === false);
}

// ---------- HTTP 集成：真实启动服务，打新 API ----------
const SERVER = path.join(__dirname, '..', 'server.js');

const getFreePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});

const request = (port, method, urlPath, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port, path: urlPath, method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
  }, (res) => {
    let buf = '';
    res.on('data', (d) => { buf += d; });
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(buf); } catch (e) { /* 保留 null */ }
      resolve({ status: res.statusCode, body: json });
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

const waitReady = async (port, child) => {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`服务提前退出（code=${child.exitCode}）`);
    try {
      const r = await request(port, 'GET', '/api/stories');
      if (r.status === 200) return;
    } catch (e) { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务启动超时');
};

(async () => {
  console.log('HTTP API 集成：');
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathquery-test-'));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, SEED_ON_START: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  try {
    await waitReady(port, child);

    const created = await request(port, 'POST', '/api/stories', storyA);
    ok('创建剧情 201', created.status === 201 && created.body.id);
    const id = created.body.id;

    const q1 = await request(port, 'POST', `/api/stories/${id}/path-query`, {
      targetScene: 't', constraints: [{ variable: 'a', value: true }],
    });
    ok('已保存剧情查询命中（2 步）', q1.status === 200 && q1.body.found === true && q1.body.depth === 2);
    ok('响应带每步状态与 knownVars', Array.isArray(q1.body.path)
      && q1.body.path[2].state.a === true && Array.isArray(q1.body.knownVars));

    const q2 = await request(port, 'POST', '/api/path-query', {
      story: storyA,
      query: { targetScene: 't', constraints: [{ variable: 'a', value: true }, { variable: 'b', value: false }] },
    });
    ok('草稿查询（不落盘）返回无解 + 可断言', q2.status === 200
      && q2.body.found === false && q2.body.canAssertUnsatisfiable === true);
    ok('草稿查询返回缺失变量', q2.body.closest && q2.body.closest.missing.length === 1
      && q2.body.closest.missing[0].variable === 'a');

    const bad1 = await request(port, 'POST', '/api/path-query', { query: { targetScene: 't' } });
    ok('缺少剧情内容返回 400', bad1.status === 400 && bad1.body.error);

    const bad2 = await request(port, 'POST', '/api/path-query', {
      story: storyA,
      query: { targetScene: 't', constraints: [{ variable: 'a', value: true }, { variable: 'a', value: false }] },
    });
    ok('冲突约束返回 400', bad2.status === 400 && /约束冲突/.test(bad2.body.error));

    const bad3 = await request(port, 'POST', `/api/stories/${id}/path-query`, {});
    ok('缺少目标场景返回 400', bad3.status === 400 && /目标场景/.test(bad3.body.error));

    const bad4 = await request(port, 'POST', '/api/stories/no-such-id/path-query', { targetScene: 't' });
    ok('剧情不存在返回 404', bad4.status === 404);

    const list = await request(port, 'GET', '/api/stories');
    ok('既有列表接口不受影响', list.status === 200 && list.body.length === 1);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (stderr.trim()) console.error(`[server stderr]\n${stderr}`);
  }

  console.log(`\n全部 ${passed} 项目标路径查询断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
