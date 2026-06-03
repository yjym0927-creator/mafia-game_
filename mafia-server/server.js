const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
let server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {};

// 유틸: 6자리 랜덤 방 코드 생성
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms[code]);
    return code;
}

// 승리 조건 체크 함수
function checkWinConditions(room) {
    const alivePlayers = room.players.filter(p => p.isAlive);
    const mafiaSide = alivePlayers.filter(p => p.role === 'mafia' || p.role === 'chameleon').length;
    const citizenSide = alivePlayers.length - mafiaSide;

    if (mafiaSide === 0) {
        io.to(room.id).emit('gameOver', { winner: 'citizen' });
        delete rooms[room.id];
        return true;
    }
    if (mafiaSide >= citizenSide) {
        io.to(room.id).emit('gameOver', { winner: 'mafia' });
        delete rooms[room.id];
        return true;
    }
    return false;
}

// 밤 능력 정산 시스템 (구조 개선)
function processNightResolution(room) {
    let killedIds = new Set();
    let savedIds = new Set();
    let chatMessages = [];
    let reporterNews = "";

    // 1. 의사 치료 적용 (살아있는 의사들의 선택 취합)
    room.players.filter(p => p.isAlive && p.role === 'doctor').forEach(doc => {
        const target = room.actions.doctor[doc.id];
        if (target) savedIds.add(target);
    });

    // 2. 마피아/카멜레온 공격 적용 (마피아 투표 중 가장 많이 나온 타겟 선정)
    const mafiaVotes = {};
    room.players.filter(p => p.isAlive && (p.role === 'mafia' || p.role === 'chameleon')).forEach(maf => {
        const target = room.actions.mafia[maf.id];
        if (target) mafiaVotes[target] = (mafiaVotes[target] || 0) + 1;
    });

    let mafiaTarget = null;
    let maxMafiaVotes = 0;
    Object.keys(mafiaVotes).forEach(tId => {
        if (mafiaVotes[tId] > maxMafiaVotes) {
            maxMafiaVotes = mafiaVotes[tId];
            mafiaTarget = tId;
        }
    });

    if (mafiaTarget) {
        if (savedIds.has(mafiaTarget)) {
            chatMessages.push("의사의 극적인 치료로 밤새 아무도 사망하지 않았습니다.");
        } else {
            killedIds.add(mafiaTarget);
            const targetPlayer = room.players.find(p => p.id === mafiaTarget);
            chatMessages.push(`무자비한 마피아의 공격으로 [ ${targetPlayer.username} ] 님이 사망하셨습니다.`);
            
            // 카멜레온 특수 능력 트리거 (공격 대상이 사망 시 신분 복제 발동)
            const chameleon = room.players.find(p => p.isAlive && p.role === 'chameleon');
            if (chameleon) {
                io.to(chameleon.id).emit('chameleonSkillTrigger', { 
                    players: room.players.filter(p => p.isAlive && p.id !== chameleon.id) 
                });
            }
        }
    } else {
        chatMessages.push("고요한 밤이 지나고 아무도 사망하지 않았습니다.");
    }

    // 3. 경찰 사살/조사 적용
    room.players.filter(p => p.isAlive && p.role === 'police').forEach(pol => {
        const policeTarget = room.actions.police[pol.id];
        if (policeTarget) {
            const targetPlayer = room.players.find(p => p.id === policeTarget);
            if (targetPlayer && (targetPlayer.role === 'mafia' || targetPlayer.role === 'chameleon')) {
                killedIds.add(policeTarget);
                chatMessages.push(`정의로운 경찰의 저격으로 마피아 진영인 [ ${targetPlayer.username} ] 님이 사망하셨습니다.`);
            } else if (targetPlayer) {
                chatMessages.push(`경찰이 [ ${targetPlayer.username} ] 님을 사살하려 했으나 마피아가 아니었습니다.`);
            }
        }
    });

    // 4. 기자 특종 취재 적용
    room.players.filter(p => p.isAlive && p.role === 'reporter').forEach(rep => {
        const reporterTarget = room.actions.reporter[rep.id];
        const skipped = room.actions.reporterSkipped[rep.id];

        if (reporterTarget && !skipped) {
            const targetPlayer = room.players.find(p => p.id === reporterTarget);
            if (targetPlayer) {
                const roleKorean = {
                    mafia: '마피아 🕵️', chameleon: '카멜레온 🦎', doctor: '의사 💉', 
                    police: '경찰 🚨', citizen: '시민 🧍', jester: '제스터 🤡', reporter: '기자 📰'
                }[targetPlayer.role] || '시민 🧍';
                
                reporterNews = `📰 [기자 특종] 밤샘 취재 결과, [ ${targetPlayer.username} ] 님의 진짜 직업은 [ ${roleKorean} ] 으로 밝혀졌습니다!`;
                room.cooldowns[rep.id] = 2; // 취재 성공 시 2턴 쿨다운 설정
            }
        }
    });

    // 사망 처리 확정
    killedIds.forEach(id => {
        const p = room.players.find(player => player.id === id);
        if (p) p.isAlive = false;
    });

    // 액션 저장소 초기화 구조 변경
    room.status = 'day';
    room.actions = { mafia: {}, doctor: {}, police: {}, reporter: {}, reporterSkipped: {} };
    room.votes = {};

    // 승리 조건 검사
    if (checkWinConditions(room)) return;

    // 낮 시작 이벤트 전송
    io.to(room.id).emit('dayStarted', {
        status: 'day',
        message: chatMessages.join('\n'),
        reporterNews: reporterNews || null,
        players: room.players,
        cooldowns: room.cooldowns
    });
}

// ⭐️ 밤 능력 상호작용 인원수 기반 완벽 검사 함수
function checkNightActionsComplete(room) {
    // 오직 '살아있는' 플레이어 기준으로만 체크
    const alivePlayers = room.players.filter(p => p.isAlive);
    
    const mafias = alivePlayers.filter(p => p.role === 'mafia' || p.role === 'chameleon');
    const doctors = alivePlayers.filter(p => p.role === 'doctor');
    const polices = alivePlayers.filter(p => p.role === 'police');
    const reporters = alivePlayers.filter(p => p.role === 'reporter' && (!room.cooldowns[p.id] || room.cooldowns[p.id] === 0));

    // 살아있는 인원수만큼 누락 없이 행동(또는 스킵)이 수집되었는지 체크
    const mafiaDone = mafias.every(p => room.actions.mafia[p.id]);
    const doctorDone = doctors.every(p => room.actions.doctor[p.id]);
    const policeDone = polices.every(p => room.actions.police[p.id]);
    const reporterDone = reporters.every(p => room.actions.reporter[p.id] || room.actions.reporterSkipped[p.id]);

    // 모든 살아있는 특수직업군이 행동을 완료했다면 정산으로 전환!
    if (mafiaDone && doctorDone && policeDone && reporterDone) {
        processNightResolution(room);
    }
}

io.on('connection', (socket) => {
    console.log(`[연결] Socket ID: ${socket.id}`);

    // 1. 방 생성
    socket.on('createRoom', ({ username }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId, 
            players: [], 
            status: 'waiting', 
            masterId: socket.id,
            settings: { maxPlayers: 8, mafiaCount: 0, chameleonCount: 1, doctorCount: 1, policeCount: 1, jesterCount: 0, reporterCount: 0, antiSpam: false },
            actions: { mafia: {}, doctor: {}, police: {}, reporter: {}, reporterSkipped: {} }, // 맵 형태로 구조 변경
            votes: {},
            cooldowns: {}
        };
        socket.emit('roomCreated', { roomId });
    });

    // 2. 방 입장
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', '방이 존재하지 않습니다.');
        if (room.players.find(p => p.id === socket.id)) return;

        socket.join(roomId);
        
        const isMaster = (room.players.length === 0 || room.masterId === socket.id);
        room.players.push({ id: socket.id, username, role: null, isAlive: true, isMaster: isMaster });
        
        io.to(roomId).emit('roomData', room);
    });

    // 3. 설정 변경 동기화
    socket.on('updateSettings', ({ roomId, settings }) => {
        if (rooms[roomId]) {
            rooms[roomId].settings = settings;
            io.to(roomId).emit('settingsUpdated', settings);
        }
    });

    // 4. 게임 시작
    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        room.status = 'night';
        const s = room.settings;
        let roles = [];
        
        for(let i=0; i<(s.mafiaCount || 0); i++) roles.push('mafia');
        for(let i=0; i<(s.chameleonCount || 0); i++) roles.push('chameleon');
        for(let i=0; i<(s.doctorCount || 0); i++) roles.push('doctor');
        for(let i=0; i<(s.policeCount || 0); i++) roles.push('police');
        for(let i=0; i<(s.jesterCount || 0); i++) roles.push('jester');
        for(let i=0; i<(s.reporterCount || 0); i++) roles.push('reporter');
        
        while (roles.length < room.players.length) roles.push('citizen');
        roles.sort(() => Math.random() - 0.5);

        room.players.forEach((p, i) => {
            p.role = roles[i];
            p.isAlive = true;
            io.to(p.id).emit('assignRole', { role: p.role });
        });

        room.actions = { mafia: {}, doctor: {}, police: {}, reporter: {}, reporterSkipped: {} };
        room.votes = {};
        room.cooldowns = {};

        io.to(roomId).emit('gameStarted', { status: room.status, players: room.players, cooldowns: room.cooldowns });
    });

    // 5. 채팅 메커니즘
    socket.on('sendMessage', ({ roomId, message, username, type }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (type === 'game') {
            if (room.status === 'night') {
                if (player.role === 'mafia' || player.role === 'chameleon') {
                    room.players.forEach(p => {
                        if (p.role === 'mafia' || p.role === 'chameleon') {
                            io.to(p.id).emit('receiveMessage', { username, message, type, isSecret: true });
                        }
                    });
                }
            } else {
                if (player.isAlive) {
                    io.to(roomId).emit('receiveMessage', { username, message, type, isSecret: false });
                }
            }
        } else {
            io.to(roomId).emit('receiveMessage', { username, message, type, isSecret: false });
        }
    });

    // 6. 밤 상호작용 관련 액션 모음 (ID 개별 매핑 방식으로 수정)
    socket.on('mafiaAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (room && room.status === 'night') { 
            room.actions.mafia[socket.id] = targetId; 
            checkNightActionsComplete(room); 
        }
    });
    socket.on('doctorAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (room && room.status === 'night') { 
            room.actions.doctor[socket.id] = targetId; 
            checkNightActionsComplete(room); 
        }
    });
    socket.on('policeAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (room && room.status === 'night') { 
            room.actions.police[socket.id] = targetId; 
            checkNightActionsComplete(room); 
        }
    });
    socket.on('reporterAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (room && room.status === 'night') { 
            room.actions.reporter[socket.id] = targetId; 
            checkNightActionsComplete(room); 
        }
    });
    socket.on('reporterSkip', ({ roomId }) => {
        const room = rooms[roomId];
        if (room && room.status === 'night') { 
            room.actions.reporterSkipped[socket.id] = true; 
            checkNightActionsComplete(room); 
        }
    });

    // 7. 카멜레온 신분 절도 기능
    socket.on('chameleonExchangeName', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const chameleon = room.players.find(p => p.id === socket.id && p.role === 'chameleon');
        const target = room.players.find(p => p.id === targetId);
        
        if (chameleon && target) {
            const tempName = chameleon.username;
            chameleon.username = target.username;
            target.username = tempName;
            io.to(roomId).emit('systemMessage', `🦎 카멜레온이 누군가의 신분(닉네임)을 완벽하게 탈취하여 교란을 시작했습니다!`);
        }
    });

    // 8. 낮 투표 집계 정산
    socket.on('dayVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !voter.isAlive) return;

        room.votes[socket.id] = targetId;
        const targetName = targetId === 'skip' ? '투표 건너뛰기' : room.players.find(p => p.id === targetId).username;
        io.to(roomId).emit('voteProgress', { voterName: voter.username, targetName });

        const alivePlayers = room.players.filter(p => p.isAlive);
        if (Object.keys(room.votes).length >= alivePlayers.length) {
            const voteCounts = {};
            let maxVotes = 0;
            let mostVotedId = null;
            let isTie = false;

            Object.values(room.votes).forEach(tId => { voteCounts[tId] = (voteCounts[tId] || 0) + 1; });
            Object.keys(voteCounts).forEach(tId => {
                if (voteCounts[tId] > maxVotes) { maxVotes = voteCounts[tId]; mostVotedId = tId; isTie = false; }
                else if (voteCounts[tId] === maxVotes) { isTie = true; }
            });

            let resultMessage = "";
            if (isTie || mostVotedId === 'skip' || !mostVotedId) {
                resultMessage = "주민들의 의견이 일치하지 않거나 과반수가 건너뛰기를 선택하여 처형이 무산되었습니다.";
            } else {
                const executed = room.players.find(p => p.id === mostVotedId);
                if (executed) {
                    executed.isAlive = false;
                    resultMessage = `주민들의 압도적인 의심을 받은 [ ${executed.username} ] 님이 단두대에서 처형되었습니다.`;

                    if (executed.role === 'jester') {
                        io.to(room.id).emit('gameOver', { winner: 'jester', winnerName: executed.username });
                        delete rooms[room.id];
                        return;
                    }
                }
            }

            if (checkWinConditions(room)) return;

            Object.keys(room.cooldowns).forEach(id => { if (room.cooldowns[id] > 0) room.cooldowns[id]--; });

            room.status = 'night';
            room.actions = { mafia: {}, doctor: {}, police: {}, reporter: {}, reporterSkipped: {} };
            room.votes = {};

            io.to(room.id).emit('nightStarted', { status: 'night', message: resultMessage, players: room.players, cooldowns: room.cooldowns });
        }
    });

    // 퇴장 처리
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                const wasMaster = room.players[idx].isMaster;
                room.players.splice(idx, 1);
                
                if (wasMaster && room.players.length > 0) {
                    room.masterId = room.players[0].id;
                    room.players[0].isMaster = true;
                }
                
                io.to(roomId).emit('roomData', room);
                if (room.status !== 'waiting') checkWinConditions(room);
                if (room.players.length === 0) delete rooms[roomId];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 모든 클라이언트와 동기화 완료! 서버 가동 중: ${PORT}`));
