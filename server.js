const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- 游戏核心数据 ---
let players = {};
let playerIds = [];
let currentTurnIndex = 0;

let deck = [];
let topCardPublic = null;

let discardPile = []; // 弃牌堆：仅存已使用/消耗/爆炸的牌

// 游戏阶段
let phase = 'waiting'; // waiting | playing | ended
let winnerId = null;

// 拆弹锁：抽到炸弹并用拆除后，必须先 insertBomb 才能继续
let defusingPlayerId = null;

// 攻击机制：为玩家累积“额外回合数”
let pendingExtraTurns = {}; // { [playerId]: number } 额外回合（在其下一次成为当前玩家时生效）
let currentTurnsLeft = 1;   // 当前玩家还需要完成的回合数（包含本回合）

const MIN_PLAYERS = 2;

// 初始手牌
const STARTING_HAND = ['拆除', '拆除', '普通牌'];

// 洗牌：加入 攻击、预知
function shuffleDeck() {
  const cards = [
    '炸弹', '炸弹', '炸弹', '炸弹',
    '拆除', '拆除',
    '跳过', '跳过',
    '攻击', '攻击',
    '预知', '预知',
    '克隆牌', '克隆牌',
    '普通牌', '普通牌', '普通牌', '普通牌', '普通牌'
  ];

  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
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

function buildState() {
  const currentTurn =
    (phase === 'playing' && playerIds[currentTurnIndex])
      ? playerIds[currentTurnIndex]
      : null;

  return {
    players,
    deckCount: deck.length,
    currentTurn,
    topCardPublic,

    discardCount: discardPile.length,
    discardTopCard: discardTop(),

    phase,
    winnerId,

    // 让前端能看见“当前玩家还剩几回合”（攻击效果可视化）
    turnsLeftForCurrent: (phase === 'playing' && currentTurn) ? currentTurnsLeft : 0
  };
}

function broadcastState() {
  io.emit('gameState', buildState());
}

// 从某个索引开始找下一个活人索引
function getNextAliveIndex(fromIndex) {
  if (playerIds.length === 0) return -1;

  for (let step = 1; step <= playerIds.length; step++) {
    const idx = (fromIndex + step) % playerIds.length;
    const pid = playerIds[idx];
    if (players[pid] && !players[pid].isDead) return idx;
  }
  return -1;
}

// 设置当前回合玩家，并把其 pendingExtraTurns 兑现到 currentTurnsLeft
function setCurrentTurnIndex(idx) {
  currentTurnIndex = idx;

  const pid = playerIds[currentTurnIndex];
  if (!pid) {
    currentTurnsLeft = 1;
    return;
  }

  const extra = pendingExtraTurns[pid] || 0;
  pendingExtraTurns[pid] = 0;

  currentTurnsLeft = 1 + extra; // 本回合 + 额外回合
}

// 结束一“回合”（注意：攻击会跳过抽牌并结束你的全部剩余回合）
function endOneTurnOrAdvance() {
  if (phase !== 'playing') return;
  if (defusingPlayerId) {
    // 拆弹未完成时不允许结算回合
    broadcastState();
    return;
  }

  const alive = getAlivePlayers();
  if (alive.length <= 1) {
    endRound(alive.length === 1 ? alive[0] : null);
    return;
  }

  // 当前玩家完成了一个回合
  currentTurnsLeft -= 1;

  if (currentTurnsLeft > 0) {
    // 仍然是同一玩家继续回合
    broadcastState();
    return;
  }

  // 切到下一个活人
  const nextIdx = getNextAliveIndex(currentTurnIndex);
  if (nextIdx === -1) {
    endRound(null);
    return;
  }

  setCurrentTurnIndex(nextIdx);
  broadcastState();
}

function endRound(newWinnerId) {
  phase = 'ended';
  winnerId = newWinnerId;

  topCardPublic = null;
  defusingPlayerId = null;

  currentTurnIndex = 0;
  currentTurnsLeft = 0;

  io.emit('gameOver', { winnerId });
  broadcastState();
}

function startNewRound() {
  deck = shuffleDeck();
  topCardPublic = null;
  discardPile = [];

  phase = 'playing';
  winnerId = null;
  defusingPlayerId = null;

  pendingExtraTurns = {};
  currentTurnsLeft = 1;

  // 全员复活发牌
  for (const id of playerIds) {
    if (!players[id]) continue;
    players[id].isDead = false;
    players[id].hand = [...STARTING_HAND];
  }

  // 设置先手为第一个活人（一般就是 playerIds[0]）
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

function recomputePhaseAndMaybeEndOrStart() {
  // 清理无效 id
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

    // 如果当前玩家无效/死亡，切到下一个活人
    const curId = playerIds[currentTurnIndex];
    if (!curId || !players[curId] || players[curId].isDead) {
      const nextIdx = getNextAliveIndex(currentTurnIndex);
      if (nextIdx === -1) endRound(null);
      else setCurrentTurnIndex(nextIdx);
    }

    broadcastState();
    return;
  }

  // ended：保持广播
  broadcastState();
}

function validateCanPlayActiveCard(socket) {
  if (phase !== 'playing') return { ok: false, msg: '当前不是游戏进行中，无法出牌' };
  if (defusingPlayerId) return { ok: false, msg: '正在拆弹中，必须先把炸弹塞回去' };
  if (!players[socket.id] || players[socket.id].isDead) return { ok: false, msg: '你已死亡，无法出牌' };
  if (socket.id !== playerIds[currentTurnIndex]) return { ok: false, msg: '还没轮到你，不能出牌' };
  return { ok: true };
}

// 执行“主动牌效果”（克隆也会复用这里）
function resolveActiveEffect(actorId, card, socketForErrors) {
  // 跳过：结束一个回合，不抽牌
  if (card === '跳过') {
    endOneTurnOrAdvance();
    return;
  }

  // 攻击：结束当前玩家所有剩余回合，并把“2回合”加到下一个活人身上
  if (card === '攻击') {
  const nextIdx = getNextAliveIndex(currentTurnIndex);
  if (nextIdx === -1) {
    endRound(actorId);
    return;
  }
    const nextId = playerIds[nextIdx];

  // 下家总共 2 回合：在其“成为当前玩家时”，turnsLeft = 1 + pendingExtra
  // 所以这里加 1（不是 2）
    pendingExtraTurns[nextId] = (pendingExtraTurns[nextId] || 0) + 1;

  // 结束当前这 1 个回合（不抽牌）
    endOneTurnOrAdvance();
    return;
  }

  // 预知：查看牌顶三张（不结束回合）
  if (card === '预知') {
    const top3 = [];
    for (let k = 1; k <= 3; k++) {
      const idx = deck.length - k;
      if (idx >= 0) top3.push(deck[idx]); // top-first
    }
    emitToPlayer(actorId, 'previewCards', { cards: top3 });
    broadcastState();
    return;
  }

  if (socketForErrors) {
    socketForErrors.emit('errorMsg', { message: `未知效果牌：${card}` });
  }
}

io.on('connection', (socket) => {
  console.log('玩家加入: ' + socket.id);

  players[socket.id] = {
    id: socket.id,
    hand: [...STARTING_HAND],
    isDead: false
  };

  if (!playerIds.includes(socket.id)) playerIds.push(socket.id);

  recomputePhaseAndMaybeEndOrStart();

  // 单播给新玩家，避免首帧丢失
  socket.emit('gameState', buildState());

  socket.on('requestState', () => {
    socket.emit('gameState', buildState());
  });

  // 出牌：跳过 / 攻击 / 预知 / 克隆牌
  socket.on('playCard', ({ card } = {}) => {
    const v = validateCanPlayActiveCard(socket);
    if (!v.ok) {
      socket.emit('errorMsg', { message: v.msg });
      return;
    }

    if (!card) {
      socket.emit('errorMsg', { message: '出牌参数错误：缺少 card' });
      return;
    }

    const hand = players[socket.id].hand;

    // 克隆牌：克隆弃牌堆顶牌的效果（支持：跳过/攻击/预知）
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
      if (!['跳过', '攻击', '预知'].includes(top)) {
        socket.emit('errorMsg', { message: `弃牌堆顶牌为【${top}】，当前不可克隆其效果` });
        return;
      }

      // 消耗克隆牌并弃置克隆牌（注意：不要动顶牌）
      hand.splice(idx, 1);
      discard('克隆牌');

      io.emit('cardPlayed', { id: socket.id, card: '克隆牌', clonedCard: top });

      // 执行克隆效果（不再弃置顶牌，因为它本来就在弃牌堆）
      resolveActiveEffect(socket.id, top, socket);
      return;
    }

    // 其他主动牌：必须在手里
    if (!['跳过', '攻击', '预知'].includes(card)) {
      socket.emit('errorMsg', { message: `暂不支持此卡牌：${card}` });
      return;
    }

    const idx = hand.indexOf(card);
    if (idx === -1) {
      socket.emit('errorMsg', { message: `你没有【${card}】` });
      return;
    }

    // 弃置并广播
    hand.splice(idx, 1);
    discard(card);

    io.emit('cardPlayed', { id: socket.id, card });

    // 执行效果
    resolveActiveEffect(socket.id, card, socket);
  });

  // 抽牌
  socket.on('drawCard', () => {
    if (phase !== 'playing') {
      socket.emit('errorMsg', { message: '需要至少 2 名玩家且游戏进行中才能抽牌' });
      return;
    }
    if (defusingPlayerId) return;
    if (socket.id !== playerIds[currentTurnIndex]) return;
    if (!players[socket.id] || players[socket.id].isDead) return;

    if (deck.length === 0) {
      socket.emit('errorMsg', { message: '牌库已空，无法抽牌' });
      return;
    }

    const card = deck.pop();
    topCardPublic = null;

    if (card === '炸弹') {
      const player = players[socket.id];

  // --- 新增规则：弃牌堆顶牌是拆除 && 自己有克隆 -> 优先用克隆拆弹 ---
  // 注意：这里必须在“自己手里有拆除”之前判断，才能做到“优先消耗克隆”
  const cloneIndex = player.hand.indexOf('克隆牌');
  const canCloneAsDefuse = (cloneIndex !== -1) && (discardTop() === '拆除');

  if (canCloneAsDefuse) {
    // 消耗克隆牌
    player.hand.splice(cloneIndex, 1);
    discard('克隆牌');

    // 可选：广播一下动作（你客户端已支持 clonedCard 的展示）
    io.emit('cardPlayed', { id: socket.id, card: '克隆牌', clonedCard: '拆除' });

    // 进入拆弹态
    defusingPlayerId = socket.id;

    broadcastState();
    socket.emit('askInsertBomb', { maxIndex: deck.length });
    return;
  }

  // --- 原有规则：自己手里有拆除 -> 用拆除拆弹 ---
  const defuseIndex = player.hand.indexOf('拆除');
  if (defuseIndex !== -1) {
    player.hand.splice(defuseIndex, 1);
    discard('拆除');

    defusingPlayerId = socket.id;

    broadcastState();
    socket.emit('askInsertBomb', { maxIndex: deck.length });
    return;
  }

      // 没拆除：死亡 + 炸弹弃置（用于可视化爆炸）
      player.isDead = true;
      discard('炸弹');

      io.emit('playerDied', { id: socket.id });

      // 死亡后立刻判定是否结束
      recomputePhaseAndMaybeEndOrStart();

      // 若还在 playing，当前玩家的回合结束，推进到下一个
      if (phase === 'playing') {
        currentTurnsLeft = 0; // 当前玩家已经死，强制结束其回合
        endOneTurnOrAdvance();
      }
      return;
    }

    // 非炸弹：入手，并结束一个回合
    players[socket.id].hand.push(card);
    endOneTurnOrAdvance();
  });

  // 塞炸弹（仅拆弹玩家）
  socket.on('insertBomb', ({ index, isPublic }) => {
    if (phase !== 'playing') return;
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

    // 插完炸弹后，结束一个回合（算作该回合抽到了炸弹并处理完）
    endOneTurnOrAdvance();
  });

  // 再来一局
  socket.on('restartGame', () => {
    if (playerIds.length < MIN_PLAYERS) {
      phase = 'waiting';
      winnerId = null;
      topCardPublic = null;
      defusingPlayerId = null;
      currentTurnIndex = 0;
      currentTurnsLeft = 0;
      pendingExtraTurns = {};

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

    // 清理攻击债务
    delete pendingExtraTurns[socket.id];

    recomputePhaseAndMaybeEndOrStart();
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
