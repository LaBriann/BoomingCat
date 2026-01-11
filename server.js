const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- 游戏核心数据 ---
let players = {};            // { [id]: { id, hand:[], isDead } }
let playerIds = [];
let currentTurnIndex = 0;

let deck = [];
let topCardPublic = null;

let discardPile = [];

// 游戏阶段
let phase = 'waiting';       // waiting | playing | ended
let winnerId = null;

// 拆弹锁
let defusingPlayerId = null;

// 攻击机制：额外回合债务
let pendingExtraTurns = {};  // { [playerId]: number }
let currentTurnsLeft = 1;

const MIN_PLAYERS = 2;

// 角色牌（成对牌）
const CHARACTER_CARDS = ['海绵爸爸', '派小星', '章鱼弟'];

// --- 阻止机制：待结算动作（可被阻止） ---
let pendingAction = null;
let pendingActionTimer = null;
const NOPE_WINDOW_MS = 5000;

// --- 聊天 ---
const CHAT_MAX = 80;
let chatHistory = []; // [{id,text,ts}]

// ---------------- 工具函数 ----------------
function shuffleArrayInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function discard(card) {
  if (!card) return;
  discardPile.push(card);
}

function discardTop() {
  return discardPile.length ? discardPile[discardPile.length - 1] : null;
}

function getAlivePlayers() {
  return playerIds.filter(pid => players[pid] && !players[pid].isDead);
}

function emitToPlayer(id, event, payload) {
  io.to(id).emit(event, payload);
}

function getNextAliveIndex(fromIndex) {
  if (playerIds.length === 0) return -1;
  for (let step = 1; step <= playerIds.length; step++) {
    const idx = (fromIndex + step) % playerIds.length;
    const pid = playerIds[idx];
    if (players[pid] && !players[pid].isDead) return idx;
  }
  return -1;
}

function setCurrentTurnIndex(idx) {
  currentTurnIndex = idx;
  const pid = playerIds[currentTurnIndex];
  if (!pid) {
    currentTurnsLeft = 1;
    return;
  }
  const extra = pendingExtraTurns[pid] || 0;
  pendingExtraTurns[pid] = 0;
  currentTurnsLeft = 1 + extra;
}

function clearPendingAction(reason = null) {
  if (pendingActionTimer) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = null;
  }
  pendingAction = null;

  if (reason) io.emit('actionResolved', { cancelled: true, reason });
}

// ---------------- 新的牌库配置 ----------------
// 18 张成对牌（每类 6 张），6 阻止，3 拆除，5 炸弹，其他功能牌各 6 张
function buildDeckBySpec() {
  const cards = [];

  // 成对牌：每类 6 张
  for (const c of CHARACTER_CARDS) {
    for (let i = 0; i < 6; i++) cards.push(c);
  }

  // 阻止 6
  for (let i = 0; i < 6; i++) cards.push('阻止');

  // 拆除 3（另外每位玩家开局额外拿 1 张 => 总拆除 = n + 3）
  for (let i = 0; i < 3; i++) cards.push('拆除');

  // 炸弹 5
  for (let i = 0; i < 5; i++) cards.push('炸弹');

  // 底抽 6
  for (let i = 0; i < 6; i++) cards.push('底抽');

  // 克隆 6
  for (let i = 0; i < 6; i++) cards.push('克隆牌');

  // 预知 6
  for (let i = 0; i < 6; i++) cards.push('预知');

  // 攻击 6
  for (let i = 0; i < 6; i++) cards.push('攻击');

  // 跳过 6
  for (let i = 0; i < 6; i++) cards.push('跳过');


  for (let i = 0; i < 6; i++) cards.push('洗混');

  shuffleArrayInPlace(cards);
  return cards;
}

// 从牌堆“抽一张非炸弹”（顶端 pop 方式；如果抽到炸弹就放到底部并继续找）
function drawNonBombFromDeck() {
  if (deck.length === 0) return null;

  let attempts = 0;
  const maxAttempts = deck.length;

  while (attempts < maxAttempts && deck.length > 0) {
    const c = deck.pop(); // 牌顶
    if (c !== '炸弹') return c;

    // 抽到了炸弹：放到底部（unshift）
    deck.unshift(c);
    attempts++;
  }
  return null;
}

// 给某个玩家发：随机 6 张（不含炸弹）+ 额外 1 张拆除
function dealStartingHandToPlayer(playerId) {
  if (!players[playerId]) return;

  const hand = [];

  // 额外拆除（保证每人至少有 1 张拆除）
  hand.push('拆除');

  // 再发 6 张随机牌（不包含炸弹）
  for (let i = 0; i < 6; i++) {
    const c = drawNonBombFromDeck();
    if (c) hand.push(c);
    else break;
  }

  players[playerId].hand = hand;
  players[playerId].isDead = false;
}

// ---- 隐私：只广播公共信息 + 自己手牌 ----
function buildPublicPlayers() {
  const obj = {};
  for (const pid of playerIds) {
    if (!players[pid]) continue;
    obj[pid] = {
      id: pid,
      isDead: !!players[pid].isDead,
      handCount: Array.isArray(players[pid].hand) ? players[pid].hand.length : 0
    };
  }
  return obj;
}

// ---- 由服务端下发 isMyTurn ----
function buildStateForPlayer(viewerId) {
  const currentTurn =
    (phase === 'playing' && playerIds[currentTurnIndex])
      ? playerIds[currentTurnIndex]
      : null;

  const my = players[viewerId];
  const isMyTurn =
    phase === 'playing' &&
    !!currentTurn &&
    currentTurn === viewerId &&
    my &&
    !my.isDead;

  const pa = pendingAction
    ? {
        actorId: pendingAction.actorId,
        displayCard: pendingAction.displayCard,
        effectCard: pendingAction.effectCard,
        clonedCard: pendingAction.clonedCard || null,
        nopeCount: pendingAction.nopeCount,
        resolveAt: pendingAction.resolveAt,
        pairCard: pendingAction.pairCard || null,
        targetId: pendingAction.targetId || null
      }
    : null;

  return {
    youId: viewerId,
    isMyTurn,

    players: buildPublicPlayers(),
    myHand: my?.hand || [],

    deckCount: deck.length,
    currentTurn,
    topCardPublic,

    discardCount: discardPile.length,
    discardTopCard: discardTop(),

    phase,
    winnerId,

    turnsLeftForCurrent: (phase === 'playing' && currentTurn) ? currentTurnsLeft : 0,

    pendingAction: pa,

    chatHistory
  };
}

function sendStateTo(id) {
  emitToPlayer(id, 'gameState', buildStateForPlayer(id));
}

function broadcastState() {
  for (const pid of playerIds) {
    if (!players[pid]) continue;
    sendStateTo(pid);
  }
}

function endRound(newWinnerId) {
  phase = 'ended';
  winnerId = newWinnerId;

  topCardPublic = null;
  defusingPlayerId = null;

  currentTurnIndex = 0;
  currentTurnsLeft = 0;

  clearPendingAction(null);

  io.emit('gameOver', { winnerId });
  broadcastState();
}

function recomputePhaseAndMaybeEndOrStart() {
  playerIds = playerIds.filter(pid => players[pid]);
  const connected = playerIds.length;

  if (connected < MIN_PLAYERS) {
    phase = 'waiting';
    winnerId = null;
    topCardPublic = null;
    defusingPlayerId = null;
    currentTurnIndex = 0;
    currentTurnsLeft = 0;
    pendingExtraTurns = {};
    clearPendingAction(null);
    broadcastState();
    return;
  }

  if (phase === 'waiting') {
    startNewRound();
    return;
  }

  if (phase === 'playing') {
    const alive = getAlivePlayers();
    if (alive.length <= 1) {
      endRound(alive.length === 1 ? alive[0] : null);
      return;
    }

    const curId = playerIds[currentTurnIndex];
    if (!curId || !players[curId] || players[curId].isDead) {
      const nextIdx = getNextAliveIndex(currentTurnIndex);
      if (nextIdx === -1) endRound(null);
      else setCurrentTurnIndex(nextIdx);
    }

    broadcastState();
    return;
  }

  broadcastState();
}

// ---------------- 新开局（按新发牌规则） ----------------
function startNewRound() {
  deck = buildDeckBySpec();
  topCardPublic = null;
  discardPile = [];

  phase = 'playing';
  winnerId = null;
  defusingPlayerId = null;

  pendingExtraTurns = {};
  currentTurnsLeft = 1;

  clearPendingAction(null);

  // 给所有玩家发：6 随机 + 1 拆除
  for (const id of playerIds) {
    if (!players[id]) continue;
    dealStartingHandToPlayer(id);
  }

  shuffleArrayInPlace(deck);

  const alive = getAlivePlayers();
  if (alive.length === 0) {
    phase = 'waiting';
    broadcastState();
    return;
  }

  const idx = playerIds.indexOf(alive[0]);
  setCurrentTurnIndex(idx >= 0 ? idx : 0);

  io.emit('gameRestarted');
  broadcastState();
}

function validateCanPlayTurnAction(socket) {
  if (phase !== 'playing') return { ok: false, msg: '当前不是游戏进行中，无法操作' };
  if (pendingAction) return { ok: false, msg: '有待结算动作，暂时不能进行新动作（可使用阻止）' };
  if (defusingPlayerId) return { ok: false, msg: '正在拆弹中，必须先把炸弹塞回去' };
  if (!players[socket.id] || players[socket.id].isDead) return { ok: false, msg: '你已死亡，无法操作' };
  if (socket.id !== playerIds[currentTurnIndex]) return { ok: false, msg: '还没轮到你，不能操作' };
  return { ok: true };
}

function validateCanPlayNope(socket) {
  if (phase !== 'playing') return { ok: false, msg: '当前不是游戏进行中，无法使用阻止' };
  if (!pendingAction) return { ok: false, msg: '当前没有可阻止的动作' };
  if (!players[socket.id] || players[socket.id].isDead) return { ok: false, msg: '你已死亡，无法使用阻止' };
  if (defusingPlayerId === socket.id) return { ok: false, msg: '你正在拆弹中，无法使用阻止' };
  return { ok: true };
}

// 结束一个回合
function endOneTurnOrAdvance() {
  if (phase !== 'playing') return;

  if (defusingPlayerId) {
    broadcastState();
    return;
  }

  const alive = getAlivePlayers();
  if (alive.length <= 1) {
    endRound(alive.length === 1 ? alive[0] : null);
    return;
  }

  currentTurnsLeft -= 1;

  if (currentTurnsLeft > 0) {
    broadcastState();
    return;
  }

  const nextIdx = getNextAliveIndex(currentTurnIndex);
  if (nextIdx === -1) {
    endRound(null);
    return;
  }

  setCurrentTurnIndex(nextIdx);
  broadcastState();
}

// 抽牌（支持顶/底）
function performDraw(playerId, fromBottom = false) {
  if (phase !== 'playing') return;
  if (!players[playerId] || players[playerId].isDead) return;

  if (deck.length === 0) {
    emitToPlayer(playerId, 'errorMsg', { message: '牌库已空，无法抽牌' });
    return;
  }

  topCardPublic = null;
  const card = fromBottom ? deck.shift() : deck.pop();

  if (card === '炸弹') {
    io.emit('bombDrawn', { id: playerId });

    const player = players[playerId];

    // 弃牌堆顶拆除 + 手里克隆 => 优先克隆拆除
    const cloneIndex = player.hand.indexOf('克隆牌');
    const canCloneAsDefuse = (cloneIndex !== -1) && (discardTop() === '拆除');
    if (canCloneAsDefuse) {
      player.hand.splice(cloneIndex, 1);
      discard('克隆牌');
      io.emit('cardPlayed', { id: playerId, card: '克隆牌', clonedCard: '拆除' });

      defusingPlayerId = playerId;
      broadcastState();
      emitToPlayer(playerId, 'askInsertBomb', { maxIndex: deck.length });
      return;
    }

    const defuseIndex = player.hand.indexOf('拆除');
    if (defuseIndex !== -1) {
      player.hand.splice(defuseIndex, 1);
      discard('拆除');

      defusingPlayerId = playerId;
      broadcastState();
      emitToPlayer(playerId, 'askInsertBomb', { maxIndex: deck.length });
      return;
    }

    // 死亡
    player.isDead = true;
    discard('炸弹');
    io.emit('playerDied', { id: playerId });

    recomputePhaseAndMaybeEndOrStart();

    if (phase === 'playing') {
      currentTurnsLeft = 0;
      endOneTurnOrAdvance();
    }
    return;
  }

  players[playerId].hand.push(card);
  endOneTurnOrAdvance();
}

// 执行主动效果（非成对抽取）
function resolveActiveEffect(actorId, effectCard) {
  if (effectCard === '跳过') {
    endOneTurnOrAdvance();
    return;
  }

  if (effectCard === '攻击') {
    const nextIdx = getNextAliveIndex(currentTurnIndex);
    if (nextIdx === -1) {
      endRound(actorId);
      return;
    }
    const nextId = playerIds[nextIdx];
    pendingExtraTurns[nextId] = (pendingExtraTurns[nextId] || 0) + 1;
    endOneTurnOrAdvance();
    return;
  }

  if (effectCard === '预知') {
    const top3 = [];
    for (let k = 1; k <= 3; k++) {
      const idx = deck.length - k;
      if (idx >= 0) top3.push(deck[idx]);
    }
    emitToPlayer(actorId, 'previewCards', { cards: top3 });
    broadcastState();
    return;
  }

  if (effectCard === '底抽') {
    performDraw(actorId, true);
    return;
  }

  if (effectCard === '洗混') {
    shuffleArrayInPlace(deck);
    topCardPublic = null;
    broadcastState();
    return;
  }

  broadcastState();
}

/**
 * 关键新增：统一调度 pendingAction 的计时器
 * - 支持“每次打出阻止，都重置 resolveAt，从而让阻止也有 pending 时间”
 */
function schedulePendingResolution() {
  if (pendingActionTimer) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = null;
  }
  if (!pendingAction) return;

  const delay = Math.max(0, pendingAction.resolveAt - Date.now());
  pendingActionTimer = setTimeout(() => {
    pendingActionTimer = null;

    const pa = pendingAction;
    pendingAction = null;
    if (!pa) return;

    const cancelled = (pa.nopeCount % 2 === 1);
    if (cancelled) {
      io.emit('actionResolved', { cancelled: true, reason: '已被阻止' });
      broadcastState();
      return;
    }

    io.emit('actionResolved', { cancelled: false });

    // 成对抽取结算
    if (pa.effectCard === 'PAIR_STEAL') {
      const actorId = pa.actorId;
      const targetId = pa.targetId;

      if (!players[actorId] || players[actorId].isDead) {
        broadcastState();
        return;
      }
      if (!players[targetId] || players[targetId].isDead) {
        io.emit('pairSteal', { actorId, targetId, success: false, reason: '目标已不在或已死亡' });
        broadcastState();
        return;
      }

      const targetHand = players[targetId].hand || [];
      if (targetHand.length === 0) {
        io.emit('pairSteal', { actorId, targetId, success: false, reason: '目标没有手牌' });
        broadcastState();
        return;
      }

      const idx = Math.floor(Math.random() * targetHand.length);
      const stolen = targetHand.splice(idx, 1)[0];
      players[actorId].hand.push(stolen);

      io.emit('pairSteal', { actorId, targetId, success: true });
      emitToPlayer(actorId, 'stolenCard', { card: stolen });
      emitToPlayer(targetId, 'stolenFromYou', { by: actorId });

      broadcastState();
      return;
    }

    // 其他牌照旧
    resolveActiveEffect(pa.actorId, pa.effectCard);
    broadcastState();
  }, delay);
}

// 创建可阻止动作
function createPendingAction(payload) {
  const startedAt = Date.now();
  pendingAction = {
    ...payload,
    nopeCount: 0,
    startedAt,
    resolveAt: startedAt + NOPE_WINDOW_MS
  };

  io.emit('actionPending', {
    actorId: pendingAction.actorId,
    displayCard: pendingAction.displayCard,
    effectCard: pendingAction.effectCard,
    clonedCard: pendingAction.clonedCard || null,
    nopeCount: pendingAction.nopeCount,
    resolveAt: pendingAction.resolveAt,
    pairCard: pendingAction.pairCard || null,
    targetId: pendingAction.targetId || null
  });

  broadcastState();
  schedulePendingResolution();
}

// ---------------- Socket ----------------
io.on('connection', (socket) => {
  console.log('玩家加入: ' + socket.id);

  // 新玩家注册
  players[socket.id] = {
    id: socket.id,
    hand: [],
    isDead: false
  };

  if (!playerIds.includes(socket.id)) playerIds.push(socket.id);

  // 如果当前正在游戏中：新加入的人也按规则发 6+1 拆除
  if (phase === 'playing') {
    if (deck.length === 0) deck = buildDeckBySpec();
    dealStartingHandToPlayer(socket.id);
  }

  recomputePhaseAndMaybeEndOrStart();
  sendStateTo(socket.id);

  socket.on('requestState', () => {
    sendStateTo(socket.id);
  });

  // -------- 聊天 --------
  socket.on('sendChat', ({ text } = {}) => {
    if (typeof text !== 'string') return;
    const msg = text.replace(/\s+/g, ' ').trim();
    if (!msg) return;
    if (msg.length > 200) return;

    const payload = { id: socket.id, text: msg, ts: Date.now() };
    chatHistory.push(payload);
    if (chatHistory.length > CHAT_MAX) chatHistory = chatHistory.slice(-CHAT_MAX);

    io.emit('chatMessage', payload);
    broadcastState();
  });

  // ---------------- 改动点：阻止也有 pending 时间（可被阻止） ----------------
  socket.on('playNope', () => {
    const v = validateCanPlayNope(socket);
    if (!v.ok) {
      socket.emit('errorMsg', { message: v.msg });
      return;
    }

    const hand = players[socket.id].hand;
    const idx = hand.indexOf('阻止');
    if (idx === -1) {
      socket.emit('errorMsg', { message: '你没有【阻止】' });
      return;
    }

    // 消耗阻止
    hand.splice(idx, 1);
    discard('阻止');

    // 计数 +1
    pendingAction.nopeCount += 1;

    // 关键：每次打出阻止，都重置 pending 窗口，让别人有时间阻止这个阻止
    pendingAction.resolveAt = Date.now() + NOPE_WINDOW_MS;

    io.emit('cardPlayed', { id: socket.id, card: '阻止' });
    io.emit('nopePlayed', { id: socket.id, nopeCount: pendingAction.nopeCount });

    // 广播一次 actionPending（更新前端倒计时）
    io.emit('actionPending', {
      actorId: pendingAction.actorId,
      displayCard: pendingAction.displayCard,
      effectCard: pendingAction.effectCard,
      clonedCard: pendingAction.clonedCard || null,
      nopeCount: pendingAction.nopeCount,
      resolveAt: pendingAction.resolveAt,
      pairCard: pendingAction.pairCard || null,
      targetId: pendingAction.targetId || null
    });

    broadcastState();
    schedulePendingResolution();
  });

  // 出牌（回合内）
  socket.on('playCard', ({ card } = {}) => {
    const v = validateCanPlayTurnAction(socket);
    if (!v.ok) {
      socket.emit('errorMsg', { message: v.msg });
      return;
    }
    if (!card) {
      socket.emit('errorMsg', { message: '出牌参数错误：缺少 card' });
      return;
    }

    const hand = players[socket.id].hand;

    // 角色牌单张不可打
    if (CHARACTER_CARDS.includes(card)) {
      socket.emit('errorMsg', { message: '角色牌需要两张同名一起打出' });
      return;
    }

    // 克隆牌：可克隆（跳过/攻击/预知/底抽/洗混）
    if (card === '克隆牌') {
      const idx = hand.indexOf('克隆牌');
      if (idx === -1) {
        socket.emit('errorMsg', { message: '你没有【克隆牌】' });
        return;
      }

      const top = discardTop();
      if (!top) {
        socket.emit('errorMsg', { message: '弃牌堆为空，无法克隆' });
        return;
      }

      const clonables = ['跳过', '攻击', '预知', '底抽', '洗混'];
      if (!clonables.includes(top)) {
        socket.emit('errorMsg', { message: `弃牌堆顶牌为【${top}】，当前不可克隆其效果` });
        return;
      }

      hand.splice(idx, 1);
      discard('克隆牌');

      io.emit('cardPlayed', { id: socket.id, card: '克隆牌', clonedCard: top });

      createPendingAction({
        actorId: socket.id,
        displayCard: '克隆牌',
        effectCard: top,
        clonedCard: top
      });
      return;
    }

    const playable = ['跳过', '攻击', '预知', '底抽', '洗混'];
    if (!playable.includes(card)) {
      socket.emit('errorMsg', { message: `暂不支持此卡牌：${card}` });
      return;
    }

    const idx = hand.indexOf(card);
    if (idx === -1) {
      socket.emit('errorMsg', { message: `你没有【${card}】` });
      return;
    }

    hand.splice(idx, 1);
    discard(card);

    io.emit('cardPlayed', { id: socket.id, card });

    createPendingAction({
      actorId: socket.id,
      displayCard: card,
      effectCard: card
    });
  });

  // 角色牌两张成对打出 -> 抽取目标 1 张牌
  socket.on('playPair', ({ card, targetId } = {}) => {
    const v = validateCanPlayTurnAction(socket);
    if (!v.ok) {
      socket.emit('errorMsg', { message: v.msg });
      return;
    }
    if (!CHARACTER_CARDS.includes(card)) {
      socket.emit('errorMsg', { message: '成对出牌参数错误：不是角色牌' });
      return;
    }
    if (!targetId || typeof targetId !== 'string') {
      socket.emit('errorMsg', { message: '请选择一个目标玩家' });
      return;
    }
    if (targetId === socket.id) {
      socket.emit('errorMsg', { message: '不能选择自己' });
      return;
    }
    if (!players[targetId]) {
      socket.emit('errorMsg', { message: '目标玩家不存在' });
      return;
    }

    const actor = players[socket.id];
    const hand = actor.hand;

    // 找两张
    const indices = [];
    for (let i = 0; i < hand.length; i++) {
      if (hand[i] === card) indices.push(i);
      if (indices.length === 2) break;
    }
    if (indices.length < 2) {
      socket.emit('errorMsg', { message: `你没有两张【${card}】` });
      return;
    }

    // 删两张（从大到小删）
    indices.sort((a, b) => b - a);
    hand.splice(indices[0], 1);
    hand.splice(indices[1], 1);

    // 两张都弃置（即使被阻止也弃置）
    discard(card);
    discard(card);

    io.emit('cardPlayed', { id: socket.id, card: `${card}×2` });

    createPendingAction({
      actorId: socket.id,
      displayCard: `${card}×2`,
      effectCard: 'PAIR_STEAL',
      pairCard: card,
      targetId
    });
  });

  // 抽牌（牌顶）
  socket.on('drawCard', () => {
    if (phase !== 'playing') {
      socket.emit('errorMsg', { message: '需要至少 2 名玩家且游戏进行中才能抽牌' });
      return;
    }
    if (pendingAction) {
      socket.emit('errorMsg', { message: '有待结算动作，暂时不能抽牌（可使用阻止）' });
      return;
    }
    if (defusingPlayerId) return;
    if (socket.id !== playerIds[currentTurnIndex]) return;
    if (!players[socket.id] || players[socket.id].isDead) return;

    performDraw(socket.id, false);
  });

  // 塞炸弹
  socket.on('insertBomb', ({ index, isPublic }) => {
    if (phase !== 'playing') return;
    if (pendingAction) return;
    if (socket.id !== playerIds[currentTurnIndex]) return;
    if (defusingPlayerId !== socket.id) return;
    if (!players[socket.id] || players[socket.id].isDead) return;

    let idx = Number(index);
    if (!Number.isFinite(idx)) return;
    if (idx < 0) idx = 0;
    if (idx > deck.length) idx = deck.length;

    deck.splice(idx, 0, '炸弹');

    const isAtTop = (idx === deck.length - 1);
    topCardPublic = (isAtTop && isPublic) ? '炸弹' : null;

    defusingPlayerId = null;

    io.emit('bombInserted');
    endOneTurnOrAdvance();
  });

  socket.on('restartGame', () => {
    if (playerIds.length < MIN_PLAYERS) {
      phase = 'waiting';
      winnerId = null;
      topCardPublic = null;
      defusingPlayerId = null;
      currentTurnIndex = 0;
      currentTurnsLeft = 0;
      pendingExtraTurns = {};
      clearPendingAction(null);

      io.emit('gameRestarted');
      broadcastState();
      return;
    }
    startNewRound();
  });

  socket.on('disconnect', () => {
    console.log('玩家离开: ' + socket.id);

    delete players[socket.id];
    playerIds = playerIds.filter(id => id !== socket.id);

    if (defusingPlayerId === socket.id) {
      defusingPlayerId = null;
      topCardPublic = null;
    }

    delete pendingExtraTurns[socket.id];

    if (pendingAction && pendingAction.actorId === socket.id) {
      clearPendingAction('发起者已离开，动作取消');
    }

    recomputePhaseAndMaybeEndOrStart();
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
