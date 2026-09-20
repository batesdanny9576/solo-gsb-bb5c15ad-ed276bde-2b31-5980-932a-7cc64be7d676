'use strict';

/**
 * 目标路径查询
 *
 * 编辑者指定「目标场景 + 到达时必须为真/假的变量约束」，本模块在
 * 「场景 + 完整变量状态」的具体状态空间上执行 BFS（与分析器同一套状态编码，
 * 状态数 ≤ 场景数 × 2^n，因此含环路剧情也必然终止；超过 MAX_STATES 上限则截断）。
 *
 * 结果分三类：
 *   1) found        满足全部约束的最短选项链（BFS 按层扩展，首次命中即全局最短，
 *                   即使之后发生截断也不影响该结论），含每一步的完整变量状态；
 *   2) not found    返回与目标约束差异最少（不匹配的约束变量数最少，并列取步数更短）
 *                   的可达状态、缺失变量（期望值与实际值）及对应的最近路径；
 *   3) truncated    状态数触及上限时：不能断言无解，结果中 truncated=true 且
 *                   canAssertUnsatisfiable=false，最接近结果仅覆盖已探索部分。
 *
 * 查询本身不合法（缺目标场景、约束互相矛盾等）时 normalizeQuery 抛出
 * 带 status=400 的错误；剧情侧问题（无起点、目标场景不存在等）不抛异常，
 * 以 { ok:false, error } 的形式返回，便于前端面板内联展示。
 */

const {
  encodeState, decodeState, applyAssigns, collectStateVars, compileAll, MAX_STATES,
} = require('./analyzer');

/**
 * 规整查询参数。接受：
 *   { targetScene: 'sceneId', constraints: [{ variable, value }] }
 * constraints 也兼容对象映射形式 { hasKey: true, witchHelp: false }。
 * 不合法时抛出带 status=400 的 Error。
 */
function normalizeQuery(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const targetScene = String(q.targetScene || '').trim();
  if (!targetScene) {
    throw Object.assign(new Error('缺少目标场景（targetScene）'), { status: 400 });
  }

  let list = q.constraints;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    list = Object.entries(list).map(([variable, value]) => ({ variable, value }));
  }
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list)) {
    throw Object.assign(new Error('constraints 必须是数组或对象映射'), { status: 400 });
  }

  const byVar = new Map();
  for (const item of list) {
    const variable = String((item && item.variable) || '').trim();
    if (!variable) {
      throw Object.assign(new Error('约束中存在空变量名'), { status: 400 });
    }
    const rawValue = item && item.value;
    // 兼容字符串形式的布尔值，其余按真值处理
    const value = typeof rawValue === 'string' ? rawValue !== 'false' : !!rawValue;
    if (byVar.has(variable) && byVar.get(variable) !== value) {
      throw Object.assign(
        new Error(`约束冲突：变量 "${variable}" 被同时要求为 true 和 false`),
        { status: 400 },
      );
    }
    byVar.set(variable, value);
  }

  return {
    targetScene,
    constraints: [...byVar.entries()].map(([variable, value]) => ({ variable, value })),
  };
}

/**
 * 执行目标路径查询。
 * @param story  剧情对象（草稿或已保存均可）
 * @param query  查询参数（先经 normalizeQuery 规整）
 * @param opts   { maxStates } 状态上限（默认 MAX_STATES；测试可传入小上限验证截断）
 */
function findPath(storyInput, queryInput, opts = {}) {
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0
    ? opts.maxStates
    : MAX_STATES;
  const query = normalizeQuery(queryInput);
  const { targetScene, constraints } = query;

  const story = storyInput && typeof storyInput === 'object' ? storyInput : {};
  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }

  if (!sceneMap.has(targetScene)) {
    return { ok: false, error: `目标场景 "${targetScene}" 不存在`, targetScene, constraints };
  }
  const startId = (story.startScene || '').trim();
  if (!startId) return { ok: false, error: '未指定起点场景，无法执行查询', targetScene, constraints };
  if (!sceneMap.has(startId)) {
    return { ok: false, error: `起点场景 "${startId}" 不存在`, targetScene, constraints };
  }

  const knownVars = collectStateVars({ ...story, scenes });
  const compiled = compileAll({ ...story, scenes }, knownVars);
  const { sceneCond, sceneAssigns, optData } = compiled;

  // 语法错误的条件按恒真处理（与分析器一致），但在 warnings 中明确告知
  const warnings = [];
  for (const e of compiled.errors) {
    if (e.code === 'badSyntax') {
      warnings.push(`存在条件语法错误，已按恒真处理：${e.where}（${e.message}）`);
    }
  }
  const unknownConstraintVars = constraints
    .map((c) => c.variable)
    .filter((v) => !knownVars.includes(v));
  for (const v of unknownConstraintVars) {
    warnings.push(`约束变量 "${v}" 未声明且从未被赋值，在任何状态下都恒为 false`);
  }

  const optByScene = new Map();
  for (const od of optData) {
    if (!optByScene.has(od.sceneId)) optByScene.set(od.sceneId, []);
    optByScene.get(od.sceneId).push(od);
  }

  const goalMet = (state) => constraints.every((c) => !!state[c.variable] === c.value);
  const missingOf = (state) => constraints
    .filter((c) => !!state[c.variable] !== c.value)
    .map((c) => ({ variable: c.variable, want: c.value, actual: !!state[c.variable] }));

  // ---- BFS（与分析器相同的「场景+状态位图」去重，保证终止） ----
  const visited = new Map();
  for (const id of sceneMap.keys()) visited.set(id, new Set());
  const parent = new Map(); // "sceneId\x00code" -> { parentKey, depth, edge }
  const keyOf = (id, code) => `${id}\x00${code}`;
  const queue = [];
  let truncated = false;
  let stateCount = 0;
  let found = null; // { key, depth }
  let best = null;  // 目标场景上差异最少的可达状态 { diff, depth, key, state }

  const offer = (sceneId, code, depth, predKey, edge) => {
    if (truncated || found) return;
    const set = visited.get(sceneId);
    if (!set || set.has(code)) return;
    set.add(code);
    stateCount++;
    const key = keyOf(sceneId, code);
    parent.set(key, { parentKey: predKey, depth, edge });
    if (sceneId === targetScene) {
      const state = decodeState(code, knownVars);
      const diff = missingOf(state).length;
      if (diff === 0) {
        found = { key, depth };
        return; // BFS 按层扩展，首次命中即最短，无需继续
      }
      if (!best || diff < best.diff || (diff === best.diff && depth < best.depth)) {
        best = { diff, depth, key, state };
      }
    }
    if (stateCount > maxStates) truncated = true;
    else queue.push({ sceneId, code, depth, key });
  };

  // 起点：初始状态 = 起点场景的进入赋值；起点前置不成立则整个剧情无法开始
  const startScene = sceneMap.get(startId);
  const startState = applyAssigns({}, sceneAssigns.get(startId) || []);
  const startPre = sceneCond.get(startId);
  if (startPre && !startPre.evaluate(startState)) {
    return {
      ok: true,
      found: false,
      startBlocked: true,
      sceneReachable: false,
      canAssertUnsatisfiable: true,
      truncated: false,
      statesExplored: 0,
      maxStates,
      targetScene,
      targetTitle: sceneMap.get(targetScene).title || '',
      constraints,
      knownVars,
      warnings,
      unknownConstraintVars,
      unmet: startPre.explain(startState, true),
      message: `起点场景 "${startId}" 的前置条件在初始状态下不成立，剧情无法开始，目标不可达`,
    };
  }
  offer(startId, encodeState(startState, knownVars), 0, null, null);

  let head = 0;
  while (head < queue.length && !truncated && !found) {
    const cur = queue[head++];
    const state = decodeState(cur.code, knownVars);
    for (const od of optByScene.get(cur.sceneId) || []) {
      if (od.cond && !od.cond.evaluate(state)) continue; // 条件不成立（语法错误按恒真）
      const targetId = (od.option.target || '').trim();
      if (!targetId || !sceneMap.has(targetId)) continue; // 悬空跳转
      let nextState = state;
      if (od.assigns.length) nextState = applyAssigns(nextState, od.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const targetPre = sceneCond.get(targetId);
      if (targetPre && !targetPre.evaluate(nextState)) continue; // 入口前置不满足
      offer(targetId, encodeState(nextState, knownVars), cur.depth + 1, cur.key, {
        optionIndex: od.index,
        optionText: od.option.text || '',
        target: targetId,
        targetTitle: sceneMap.get(targetId).title || '',
      });
      if (found) break;
    }
  }

  // 路径重建：起点 -> 终点，场景节点携带到达时的完整变量状态
  const buildPath = (key) => {
    const trail = [];
    let k = key;
    while (k) {
      const [sid, code] = k.split('\x00');
      const sc = sceneMap.get(sid);
      trail.push({
        kind: 'scene',
        sceneId: sid,
        title: sc ? sc.title : sid,
        state: decodeState(code, knownVars),
      });
      const p = parent.get(k);
      if (p && p.edge) trail.push({ kind: 'option', ...p.edge });
      k = p ? p.parentKey : null;
    }
    trail.reverse();
    return trail;
  };

  const result = {
    ok: true,
    found: !!found,
    startBlocked: false,
    sceneReachable: (visited.get(targetScene) || new Set()).size > 0,
    canAssertUnsatisfiable: !found && !truncated,
    truncated,
    statesExplored: stateCount,
    maxStates,
    targetScene,
    targetTitle: sceneMap.get(targetScene).title || '',
    constraints,
    knownVars,
    warnings,
    unknownConstraintVars,
  };

  if (found) {
    result.depth = found.depth;
    result.path = buildPath(found.key);
    result.finalState = result.path[result.path.length - 1].state;
    result.message = `存在满足约束的到达路径，最短 ${found.depth} 步`;
  } else {
    if (best) {
      result.closest = {
        depth: best.depth,
        state: best.state,
        missing: missingOf(best.state),
        matchedCount: constraints.length - best.diff,
        path: buildPath(best.key),
      };
    }
    if (truncated) {
      result.message = `已探索 ${stateCount} 个状态后触及上限（${maxStates}），搜索被截断：` +
        '不能断言无解，以下最接近结果仅覆盖已探索部分';
    } else if (!result.sceneReachable) {
      result.message = `已完整枚举 ${stateCount} 个可达状态：目标场景本身不可达，可以断言无解`;
    } else {
      result.message = `已完整枚举 ${stateCount} 个可达状态：目标场景可达，但没有任何到达状态满足全部约束，可以断言无解`;
    }
  }
  return result;
}

module.exports = { findPath, normalizeQuery };
