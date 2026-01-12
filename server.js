const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// =========================
// 房间管理
// =========================
const rooms = new Map(); // roomId -> roomState
const MIN_PLAYERS = 2;

// 阻止等待窗口（你要求 5s）
const NOPE_WINDOW_MS = 5000;

const CHARACTER_CARDS = ['海绵爸爸', '派小星', '章鱼弟'];

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) return null;
  if (n.length > 16) return n.slice(0, 16);
  return n;
}

function createRoomState(roomId) {
  return {
    roomId,

    // players: { [socketId]: { id, name, hand:[], isDead } }
    players: {},
    playerIds: [],
    currentTurnIndex: 0,

    deck: [],
    topCardPublic: null,

    discardPile: [],

    phase: 'waiting', // waiting | playing | ended
    winnerId: null,

    defusingPlayerId: null,

    pendingExtraTurns: {},  // { [playerId]: number }
    currentTurnsLeft: 1,

    pendingAction: null,
    pendingActionTimer: null,

    movedBombDuringDeal: false,

    chatHistory: [], // [{id,name,text,ts}]
  };
}

// =========================
// 工具函数
// =========================
function shuffleArrayInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function discard(room, card) {
  if (!card) return;
  room.discardPile.push(card);
}

function discardTop(room) {
  return room.discardPile.length ? room.discardPile[room.discardPile.length - 1] : null;
}

function getAlivePlayers(room) {
  return room.playerIds.filter(pid => room.players[pid] && !room.players[pid].isDead);
}

function getNextAliveIndex(room, fromIndex) {
  if (room.playerIds.length === 0) return -1;
  for (let step = 1; step <= room.playerIds.length; step++) {
    const idx = (fromIndex + step) % room.playerIds.length;
    const pid = room.playerIds[idx];
    if (room.players[pid] && !room.players[pid].isDead) return idx;
  }
  return -1;
}

function setCurrentTurnIndex(room, idx) {
  room.currentTurnIndex = idx;
  const pid = room.playerIds[room.currentTurnIndex];
  if (!pid) {
    room.currentTurnsLeft = 1;
    return;
  }
  const extra = room.pendingExtraTurns[pid] || 0;
  room.pendingExtraTurns[pid] = 0;
  room.currentTurnsLeft = 1 + extra;
}

function clearPendingAction(room, reason = null) {
  if (room.pendingActionTimer) {
    clearTimeout(room.pendingActionTimer);
    room.pendingActionTimer = null;
  }
  room.pendingAction = null;

  if (reason) io.to(room.roomId).emit('actionResolved', { cancelled: true, reason });
}

function buildDeckBySpec() {
  const cards = [];

  // 成对牌：每类 6 张（共 18）
  for (const c of CHARACTER_CARDS) {
    for (let i = 0; i < 6; i++) cards.push(c);
  }

  // 阻止 6
  for (let i = 0; i < 6; i++) cards.push('阻止');

  // 拆除 3（每玩家开局额外 1 张 => 总拆除 = n + 3）
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

    // 洗混 6  
  for (let i = 0; i < 6; i++) cards.push('洗混');

  shuffleArrayInPlace(cards);
  return cards;
}

function drawNonBombFromDeck(room) {
  if (room.deck.length === 0) return null;

  let attempts = 0;
  const maxAttempts = room.deck.length;

  while (attempts < maxAttempts && room.deck.length > 0) {
    const c = room.deck.pop(); // 牌顶
    if (c !== '炸弹') return c;

    // 抽到了炸弹：放到底部（unshift）
    room.deck.unshift(c);
    room.movedBombDuringDeal = true;

    attempts++;
  }
  return null;
}

// 每个玩家：随机 6（不含炸弹）+ 额外 1 拆除
function dealStartingHandToPlayer(room, playerId) {
  if (!room.players[playerId]) return;

  const hand = [];
  hand.push('拆除');

  for (let i = 0; i < 6; i++) {
    const c = drawNonBombFromDeck(room);
    if (c) hand.push(c);
    else break;
  }

  room.players[playerId].hand = hand;
  room.players[playerId].isDead = false;
}

function buildPublicPlayers(room) {
  const obj = {};
  for (const pid of room.playerIds) {
    const p = room.players[pid];
    if (!p) continue;
    obj[pid] = {
      id: pid,
      name: p.name || '未命名',
      isDead: !!p.isDead,
      handCount: Array.isArray(p.hand) ? p.hand.length : 0
    };
  }
  return obj;
}

function buildStateForPlayer(room, viewerId) {
  const currentTurn =
    (room.phase === 'playing' && room.playerIds[room.currentTurnIndex])
      ? room.playerIds[room.currentTurnIndex]
      : null;

  const my = room.players[viewerId];
  const isMyTurn =
    room.phase === 'playing' &&
    !!currentTurn &&
    currentTurn === viewerId &&
    my &&
    !my.isDead;

  const pa = room.pendingAction
    ? {
        actorId: room.pendingAction.actorId,
        displayCard: room.pendingAction.displayCard,
        effectCard: room.pendingAction.effectCard,
        clonedCard: room.pendingAction.clonedCard || null,
        nopeCount: room.pendingAction.nopeCount,
        resolveAt: room.pendingAction.resolveAt,
        pairCard: room.pendingAction.pairCard || null,
        targetId: room.pendingAction.targetId || null
      }
    : null;

  return {
    roomId: room.roomId,
    youId: viewerId,
    youName: my?.name || '',

    isMyTurn,

    players: buildPublicPlayers(room),
    myHand: my?.hand || [],

    deckCount: room.deck.length,
    currentTurn,
    topCardPublic: room.topCardPublic,

    discardCount: room.discardPile.length,
    discardTopCard: discardTop(room),

    phase: room.phase,
    winnerId: room.winnerId,

    turnsLeftForCurrent: (room.phase === 'playing' && currentTurn) ? room.currentTurnsLeft : 0,

    pendingAction: pa,

    chatHistory: room.chatHistory
  };
}

function sendStateTo(room, socketId) {
  io.to(socketId).emit('gameState', buildStateForPlayer(room, socketId));
}

function broadcastState(room) {
  for (const pid of room.playerIds) {
    if (!room.players[pid]) continue;
    sendStateTo(room, pid);
  }
}

function endRound(room, newWinnerId) {
  room.phase = 'ended';
  room.winnerId = newWinnerId;

  room.topCardPublic = null;
  room.defusingPlayerId = null;

  room.currentTurnIndex = 0;
  room.currentTurnsLeft = 0;

  clearPendingAction(room, null);

  io.to(room.roomId).emit('gameOver', { winnerId: newWinnerId });
  broadcastState(room);
}

function schedulePendingResolution(room) {
  if (room.pendingActionTimer) {
    clearTimeout(room.pendingActionTimer);
    room.pendingActionTimer = null;
  }
  if (!room.pendingAction) return;

  const delay = Math.max(0, room.pendingAction.resolveAt - Date.now());
  room.pendingActionTimer = setTimeout(() => {
    room.pendingActionTimer = null;

    const pa = room.pendingAction;
    room.pendingAction = null;
    if (!pa) return;

    const cancelled = (pa.nopeCount % 2 === 1);
    if (cancelled) {
      io.to(room.roomId).emit('actionResolved', { cancelled: true, reason: '已被阻止' });
      broadcastState(room);
      return;
    }

    io.to(room.roomId).emit('actionResolved', { cancelled: false });

    if (pa.effectCard === 'PAIR_STEAL') {
      const actorId = pa.actorId;
      const targetId = pa.targetId;

      if (!room.players[actorId] || room.players[actorId].isDead) {
        broadcastState(room);
        return;
      }
      if (!room.players[targetId] || room.players[targetId].isDead) {
        io.to(room.roomId).emit('pairSteal', { actorId, targetId, success: false, reason: '目标已不在或已死亡' });
        broadcastState(room);
        return;
      }

      const targetHand = room.players[targetId].hand || [];
      if (targetHand.length === 0) {
        io.to(room.roomId).emit('pairSteal', { actorId, targetId, success: false, reason: '目标没有手牌' });
        broadcastState(room);
        return;
      }

      const idx = Math.floor(Math.random() * targetHand.length);
      const stolen = targetHand.splice(idx, 1)[0];
      room.players[actorId].hand.push(stolen);

      io.to(room.roomId).emit('pairSteal', { actorId, targetId, success: true });
      io.to(actorId).emit('stolenCard', { card: stolen });
      io.to(targetId).emit('stolenFromYou', { by: actorId });

      broadcastState(room);
      return;
    }

    resolveActiveEffect(room, pa.actorId, pa.effectCard);
    broadcastState(room);
  }, delay);
}

function createPendingAction(room, payload) {
  const startedAt = Date.now();
  room.pendingAction = {
    ...payload,
    nopeCount: 0,
    startedAt,
    resolveAt: startedAt + NOPE_WINDOW_MS
  };

  io.to(room.roomId).emit('actionPending', {
    actorId: room.pendingAction.actorId,
    displayCard: room.pendingAction.displayCard,
    effectCard: room.pendingAction.effectCard,
    clonedCard: room.pendingAction.clonedCard || null,
    nopeCount: room.pendingAction.nopeCount,
    resolveAt: room.pendingAction.resolveAt,
    pairCard: room.pendingAction.pairCard || null,
    targetId: room.pendingAction.targetId || null
  });

  broadcastState(room);
  schedulePendingResolution(room);
}

function startNewRound(room) {
  room.deck = buildDeckBySpec();
  room.topCardPublic = null;
  room.discardPile = [];

  room.phase = 'playing';
  room.winnerId = null;
  room.defusingPlayerId = null;

  room.pendingExtraTurns = {};
  room.currentTurnsLeft = 1;

  clearPendingAction(room, null);

  room.movedBombDuringDeal = false;

  for (const id of room.playerIds) {
    if (!room.players[id]) continue;
    dealStartingHandToPlayer(room, id);
  }

  // ✅ 发完牌后再洗一次剩余牌堆，防止炸弹都沉底
  if (room.movedBombDuringDeal) {
    shuffleArrayInPlace(room.deck);
    room.movedBombDuringDeal = false;
  }

  const alive = getAlivePlayers(room);
  if (alive.length === 0) {
    room.phase = 'waiting';
    broadcastState(room);
    return;
  }

  const idx = room.playerIds.indexOf(alive[0]);
  setCurrentTurnIndex(room, idx >= 0 ? idx : 0);

  io.to(room.roomId).emit('gameRestarted');
  broadcastState(room);
}

function recomputePhaseAndMaybeEndOrStart(room) {
  room.playerIds = room.playerIds.filter(pid => room.players[pid]);
  const connected = room.playerIds.length;

  if (connected < MIN_PLAYERS) {
    room.phase = 'waiting';
    room.winnerId = null;
    room.topCardPublic = null;
    room.defusingPlayerId = null;
    room.currentTurnIndex = 0;
    room.currentTurnsLeft = 0;
    room.pendingExtraTurns = {};
    clearPendingAction(room, null);
    broadcastState(room);
    return;
  }

  if (room.phase === 'waiting') {
    startNewRound(room);
    return;
  }

  if (room.phase === 'playing') {
    const alive = getAlivePlayers(room);
    if (alive.length <= 1) {
      endRound(room, alive.length === 1 ? alive[0] : null);
      return;
    }

    const curId = room.playerIds[room.currentTurnIndex];
    if (!curId || !room.players[curId] || room.players[curId].isDead) {
      const nextIdx = getNextAliveIndex(room, room.currentTurnIndex);
      if (nextIdx === -1) endRound(room, null);
      else setCurrentTurnIndex(room, nextIdx);
    }

    broadcastState(room);
    return;
  }

  broadcastState(room);
}

function validateCanPlayTurnAction(room, socket) {
  if (room.phase !== 'playing') return { ok: false, msg: '当前不是游戏进行中，无法操作' };
  if (room.pendingAction) return { ok: false, msg: '有待结算动作，暂时不能进行新动作（可使用阻止）' };
  if (room.defusingPlayerId) return { ok: false, msg: '正在拆弹中，必须先把炸弹塞回去' };
  if (!room.players[socket.id] || room.players[socket.id].isDead) return { ok: false, msg: '你已死亡，无法操作' };
  if (socket.id !== room.playerIds[room.currentTurnIndex]) return { ok: false, msg: '还没轮到你，不能操作' };
  return { ok: true };
}

function validateCanPlayNope(room, socket) {
  if (room.phase !== 'playing') return { ok: false, msg: '当前不是游戏进行中，无法使用阻止' };
  if (!room.pendingAction) return { ok: false, msg: '当前没有可阻止的动作' };
  if (!room.players[socket.id] || room.players[socket.id].isDead) return { ok: false, msg: '你已死亡，无法使用阻止' };
  if (room.defusingPlayerId === socket.id) return { ok: false, msg: '你正在拆弹中，无法使用阻止' };
  return { ok: true };
}

function endOneTurnOrAdvance(room) {
  if (room.phase !== 'playing') return;

  if (room.defusingPlayerId) {
    broadcastState(room);
    return;
  }

  const alive = getAlivePlayers(room);
  if (alive.length <= 1) {
    endRound(room, alive.length === 1 ? alive[0] : null);
    return;
  }

  room.currentTurnsLeft -= 1;

  if (room.currentTurnsLeft > 0) {
    broadcastState(room);
    return;
  }

  const nextIdx = getNextAliveIndex(room, room.currentTurnIndex);
  if (nextIdx === -1) {
    endRound(room, null);
    return;
  }

  setCurrentTurnIndex(room, nextIdx);
  broadcastState(room);
}

function performDraw(room, playerId, fromBottom = false) {
  if (room.phase !== 'playing') return;
  if (!room.players[playerId] || room.players[playerId].isDead) return;

  if (room.deck.length === 0) {
    io.to(playerId).emit('errorMsg', { message: '牌库已空，无法抽牌' });
    return;
  }

  room.topCardPublic = null;
  const card = fromBottom ? room.deck.shift() : room.deck.pop();

  if (card === '炸弹') {
    // ✅ 抽到炸弹横幅（无论拆没拆）
    io.to(room.roomId).emit('bombDrawn', { id: playerId });

    const player = room.players[playerId];

    // 弃牌堆顶拆除 + 手里克隆 => 优先克隆拆除
    const cloneIndex = player.hand.indexOf('克隆牌');
    const canCloneAsDefuse = (cloneIndex !== -1) && (discardTop(room) === '拆除');
    if (canCloneAsDefuse) {
      player.hand.splice(cloneIndex, 1);
      discard(room, '克隆牌');
      io.to(room.roomId).emit('cardPlayed', { id: playerId, card: '克隆牌', clonedCard: '拆除' });

      io.to(room.roomId).emit('bombDefused', { id: playerId, via: '克隆牌→拆除' });

      room.defusingPlayerId = playerId;
      broadcastState(room);
      io.to(playerId).emit('askInsertBomb', { maxIndex: room.deck.length });
      return;
    }

    const defuseIndex = player.hand.indexOf('拆除');
    if (defuseIndex !== -1) {
      player.hand.splice(defuseIndex, 1);
      discard(room, '拆除');

      io.to(room.roomId).emit('bombDefused', { id: playerId, via: '拆除' });

      room.defusingPlayerId = playerId;
      broadcastState(room);
      io.to(playerId).emit('askInsertBomb', { maxIndex: room.deck.length });
      return;
    }

    // 死亡
    player.isDead = true;
    discard(room, '炸弹');
    io.to(room.roomId).emit('playerDied', { id: playerId });

    recomputePhaseAndMaybeEndOrStart(room);

    if (room.phase === 'playing') {
      room.currentTurnsLeft = 0;
      endOneTurnOrAdvance(room);
    }
    return;
  }

  room.players[playerId].hand.push(card);
  endOneTurnOrAdvance(room);
}

function resolveActiveEffect(room, actorId, effectCard) {
  if (effectCard === '跳过') {
    endOneTurnOrAdvance(room);
    return;
  }

  if (effectCard === '攻击') {
    const nextIdx = getNextAliveIndex(room, room.currentTurnIndex);
    if (nextIdx === -1) {
      endRound(room, actorId);
      return;
    }
    const nextId = room.playerIds[nextIdx];
    room.pendingExtraTurns[nextId] = (room.pendingExtraTurns[nextId] || 0) + 1;
    endOneTurnOrAdvance(room);
    return;
  }

  if (effectCard === '预知') {
    const top3 = [];
    for (let k = 1; k <= 3; k++) {
      const idx = room.deck.length - k;
      if (idx >= 0) top3.push(room.deck[idx]);
    }
    io.to(actorId).emit('previewCards', { cards: top3 });
    broadcastState(room);
    return;
  }

  if (effectCard === '底抽') {
    performDraw(room, actorId, true);
    return;
  }

  if (effectCard === '洗混') {
    shuffleArrayInPlace(room.deck);
    room.topCardPublic = null;
    broadcastState(room);
    return;
  }

  broadcastState(room);
}

// =========================
// Socket：房间流程
// =========================
function getRoomOfSocket(socket) {
  const rid = socket.data?.roomId;
  if (!rid) return null;
  return rooms.get(rid) || null;
}

function joinRoom(socket, roomId, name) {
  const rid = String(roomId || '').trim().toUpperCase();
  const nm = normalizeName(name);
  if (!nm) {
    socket.emit('roomError', { message: '昵称不能为空（最多16字）' });
    return;
  }
  if (!rid) {
    socket.emit('roomError', { message: '房间号不能为空' });
    return;
  }

  const room = rooms.get(rid);
  if (!room) {
    socket.emit('roomError', { message: '房间不存在' });
    return;
  }

  // 若之前已在别的房间，先离开
  leaveCurrentRoom(socket);

  socket.data.name = nm;
  socket.data.roomId = rid;

  socket.join(rid);

  room.players[socket.id] = {
    id: socket.id,
    name: nm,
    hand: [],
    isDead: false
  };
  if (!room.playerIds.includes(socket.id)) room.playerIds.push(socket.id);

  // 若游戏进行中，新人也要发起手牌
  if (room.phase === 'playing') {
    if (room.deck.length === 0) room.deck = buildDeckBySpec();
    dealStartingHandToPlayer(room, socket.id);
  }

  socket.emit('roomJoined', { roomId: rid, name: nm });
  recomputePhaseAndMaybeEndOrStart(room);
  sendStateTo(room, socket.id);
}

function createAndJoinRoom(socket, name) {
  const nm = normalizeName(name);
  if (!nm) {
    socket.emit('roomError', { message: '昵称不能为空（最多16字）' });
    return;
  }

  // 若之前已在别的房间，先离开
  leaveCurrentRoom(socket);

  let rid = genRoomId();
  while (rooms.has(rid)) rid = genRoomId();

  const room = createRoomState(rid);
  rooms.set(rid, room);

  socket.data.name = nm;
  socket.data.roomId = rid;

  socket.join(rid);

  room.players[socket.id] = {
    id: socket.id,
    name: nm,
    hand: [],
    isDead: false
  };
  room.playerIds.push(socket.id);

  socket.emit('roomCreated', { roomId: rid, name: nm });
  socket.emit('roomJoined', { roomId: rid, name: nm });

  recomputePhaseAndMaybeEndOrStart(room);
  sendStateTo(room, socket.id);
}

function leaveCurrentRoom(socket) {
  const rid = socket.data?.roomId;
  if (!rid) return;

  const room = rooms.get(rid);
  if (!room) {
    socket.data.roomId = null;
    return;
  }

  socket.leave(rid);

  // 从房间状态中移除
  delete room.players[socket.id];
  room.playerIds = room.playerIds.filter(id => id !== socket.id);

  if (room.defusingPlayerId === socket.id) {
    room.defusingPlayerId = null;
    room.topCardPublic = null;
  }
  delete room.pendingExtraTurns[socket.id];

  if (room.pendingAction && room.pendingAction.actorId === socket.id) {
    clearPendingAction(room, '发起者已离开，动作取消');
  }

  socket.data.roomId = null;

  // 房间空了就销毁
  if (room.playerIds.length === 0) {
    if (room.pendingActionTimer) clearTimeout(room.pendingActionTimer);
    rooms.delete(rid);
    return;
  }

  recomputePhaseAndMaybeEndOrStart(room);
}

// =========================
// Socket 主体
// =========================
io.on('connection', (socket) => {
  // 还未进房间，先等 create/join
  socket.data.roomId = null;
  socket.data.name = null;

  socket.on('createRoom', ({ name } = {}) => {
    createAndJoinRoom(socket, name);
  });

  socket.on('joinRoom', ({ roomId, name } = {}) => {
    joinRoom(socket, roomId, name);
  });

  socket.on('leaveRoom', () => {
    leaveCurrentRoom(socket);
    socket.emit('roomLeft');
  });

  socket.on('requestState', () => {
    const room = getRoomOfSocket(socket);
    if (!room) {
      socket.emit('roomError', { message: '你尚未加入房间' });
      return;
    }
    sendStateTo(room, socket.id);
  });

  // ---------------- 聊天 ----------------
  socket.on('sendChat', ({ text } = {}) => {
    const room = getRoomOfSocket(socket);
    if (!room) return;

    if (typeof text !== 'string') return;
    const msg = text.replace(/\s+/g, ' ').trim();
    if (!msg) return;
    if (msg.length > 200) return;

    const nm = room.players[socket.id]?.name || socket.data?.name || '未命名';
    const payload = { id: socket.id, name: nm, text: msg, ts: Date.now() };
    room.chatHistory.push(payload);
    if (room.chatHistory.length > 80) room.chatHistory = room.chatHistory.slice(-80);

    io.to(room.roomId).emit('chatMessage', payload);
    broadcastState(room);
  });

  // ---------------- 阻止（可被阻止，且每次阻止刷新 pending） ----------------
  socket.on('playNope', () => {
    const room = getRoomOfSocket(socket);
    if (!room) return;

    const v = validateCanPlayNope(room, socket);
    if (!v.ok) {
      socket.emit('errorMsg', { message: v.msg });
      return;
    }

    const hand = room.players[socket.id].hand;
    const idx = hand.indexOf('阻止');
    if (idx === -1) {
      socket.emit('errorMsg', { message: '你没有【阻止】' });
      return;
    }

    hand.splice(idx, 1);
    discard(room, '阻止');

    room.pendingAction.nopeCount += 1;

    // ✅ 每次阻止都刷新 5s 窗口，让“阻止阻止”有时间
    room.pendingAction.resolveAt = Date.now() + NOPE_WINDOW_MS;

    io.to(room.roomId).emit('cardPlayed', { id: socket.id, card: '阻止' });
    io.to(room.roomId).emit('nopePlayed', { id: socket.id, nopeCount: room.pendingAction.nopeCount });

    io.to(room.roomId).emit('actionPending', {
      actorId: room.pendingAction.actorId,
      displayCard: room.pendingAction.displayCard,
      effectCard: room.pendingAction.effectCard,
      clonedCard: room.pendingAction.clonedCard || null,
      nopeCount: room.pendingAction.nopeCount,
      resolveAt: room.pendingAction.resolveAt,
      pairCard: room.pendingAction.pairCard || null,
      targetId: room.pendingAction.targetId || null
    });

    broadcastState(room);
    schedulePendingResolution(room);
  });

  // ---------------- 出牌（回合内） ----------------
  socket.on('playCard', ({ card } = {}) => {
    const room = getRoomOfSocket(socket);
    if (!room) return;

    const v = validateCanPlayTurnAction(room, socket);
    if (!v.ok) {
      socket.emit('errorMsg', { message: v.msg });
      return;
    }
    if (!card) {
      socket.emit('errorMsg', { message: '出牌参数错误：缺少 card' });
      return;
    }

    const hand = room.players[socket.id].hand;

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

      const top = discardTop(room);
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
      discard(room, '克隆牌');

      io.to(room.roomId).emit('cardPlayed', { id: socket.id, card: '克隆牌', clonedCard: top });

      createPendingAction(room, {
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
    discard(room, card);

    io.to(room.roomId).emit('cardPlayed', { id: socket.id, card });

    createPendingAction(room, {
      actorId: socket.id,
      displayCard: card,
      effectCard: card
    });
  });

  // 角色牌两张成对打出 -> 抽取目标 1 张牌
  socket.on('playPair', ({ card, targetId } = {}) => {
    const room = getRoomOfSocket(socket);
    if (!room) return;

    const v = validateCanPlayTurnAction(room, socket);
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
    if (!room.players[targetId]) {
      socket.emit('errorMsg', { message: '目标玩家不存在' });
      return;
    }

    const actor = room.players[socket.id];
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
    discard(room, card);
    discard(room, card);

    io.to(room.roomId).emit('cardPlayed', { id: socket.id, card: `${card}×2` });

    createPendingAction(room, {
      actorId: socket.id,
      displayCard: `${card}×2`,
      effectCard: 'PAIR_STEAL',
      pairCard: card,
      targetId
    });
  });

  // 抽牌（牌顶）
  socket.on('drawCard', () => {
    const room = getRoomOfSocket(socket);
    if (!room) return;

    if (room.phase !== 'playing') {
      socket.emit('errorMsg', { message: '需要至少 2 名玩家且游戏进行中才能抽牌' });
      return;
    }
    if (room.pendingAction) {
      socket.emit('errorMsg', { message: '有待结算动作，暂时不能抽牌（可使用阻止）' });
      return;
    }
    if (room.defusingPlayerId) return;
    if (socket.id !== room.playerIds[room.currentTurnIndex]) return;
    if (!room.players[socket.id] || room.players[socket.id].isDead) return;

    performDraw(room, socket.id, false);
  });

  // 塞炸弹
  socket.on('insertBomb', ({ index, isPublic }) => {
    const room = getRoomOfSocket(socket);
    if (!room) return;

    if (room.phase !== 'playing') return;
    if (room.pendingAction) return;
    if (socket.id !== room.playerIds[room.currentTurnIndex]) return;
    if (room.defusingPlayerId !== socket.id) return;
    if (!room.players[socket.id] || room.players[socket.id].isDead) return;

    let idx = Number(index);
    if (!Number.isFinite(idx)) return;
    if (idx < 0) idx = 0;
    if (idx > room.deck.length) idx = room.deck.length;

    room.deck.splice(idx, 0, '炸弹');

    const isAtTop = (idx === room.deck.length - 1);
    room.topCardPublic = (isAtTop && isPublic) ? '炸弹' : null;

    room.defusingPlayerId = null;

    io.to(room.roomId).emit('bombInserted');
    endOneTurnOrAdvance(room);
  });

  socket.on('restartGame', () => {
    const room = getRoomOfSocket(socket);
    if (!room) return;

    if (room.playerIds.length < MIN_PLAYERS) {
      room.phase = 'waiting';
      room.winnerId = null;
      room.topCardPublic = null;
      room.defusingPlayerId = null;
      room.currentTurnIndex = 0;
      room.currentTurnsLeft = 0;
      room.pendingExtraTurns = {};
      clearPendingAction(room, null);

      io.to(room.roomId).emit('gameRestarted');
      broadcastState(room);
      return;
    }

    startNewRound(room);
  });

  socket.on('disconnect', () => {
    // 离开房间并清理
    leaveCurrentRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
