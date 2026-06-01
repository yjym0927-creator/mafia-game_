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

// 밤 능력 정산 시스템
function processNightResolution(room) {
    let killedIds = new Set();
    let savedIds = new Set();
    let chatMessages = [];
    let reporterNews = "";

    const mafiaTarget = room.actions.mafia;
    const doctorTarget = room.actions.doctor;
    const policeTarget = room.actions.police;
    const reporterTarget = room.actions.reporter;

    // 1. 의사 치료 적용
    if (doctorTarget) {
        savedIds.add(doctorTarget);
    }

    // 2. 마피아/카멜레온 공격 적용
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
    if (policeTarget) {
        const targetPlayer = room.players.find(p => p.id === policeTarget);
        if (targetPlayer && (targetPlayer.role === 'mafia' || targetPlayer.role === 'chameleon')) {
            killedIds.add(policeTarget);
            chatMessages.push(`정의로운 경찰의 저격으로 마피아 진영인 [ ${targetPlayer.username} ] 님이 사망하셨습니다.`);
        } else if (targetPlayer) {
            chatMessages.push(`경찰이 [ ${targetPlayer.username} ] 님을 사살하려 했으나 마피아가 아니었습니다.`);
        }
    }

    // 4. 기자 특종 취재 적용
    if (reporterTarget && !room.actions.reporterSkipped) {
        const targetPlayer = room.players.find(p => p.id === reporterTarget);
        if (targetPlayer) {
            const roleKorean = {
                mafia: '마피아 🕵️', chameleon: '카멜레온 🦎', doctor: '의사 💉', 
                police: '경찰 🚨', citizen: '시민 🧍', jester: '제스터 🤡', reporter: '기자 📰'
            }[targetPlayer.role] || '시민 🧍';
            
            reporterNews = `📰 [기자 특종] 밤샘 취재 결과, [ ${targetPlayer.username} ] 님의 진짜 직업은 [ ${roleKorean} ] 으로 밝혀졌습니다!`;
            
            const reporterPlayer = room.players.find(p => p.role === 'reporter' && p.isAlive);
            if (reporterPlayer) {
                room.cooldowns[reporterPlayer.id] = 2; // 취재 성공 시 2턴 쿨다운 설정
            }
        }
    }

    // 사망 처리 확정
    killedIds.forEach(id => {
        const p = room.players.find(player => player.id === id);
        if (p) p.isAlive = false;
    });

    room.status = 'day';
    room.actions = { mafia: null, doctor: null, police: null, reporter: null, reporterSkipped: false };
    room.votes = {};

    // 승리 조건 검사
    if (checkWinConditions(room)) return;

    // 낮 시작 이벤트 전송 (index.html 수신용)
    io.to(room.id).emit('dayStarted', {
        status: 'day',
        message: chatMessages.join('\n'),
        reporterNews: reporterNews || null,
        players: room.players,
        cooldowns: room.cooldowns
    });
}

// 밤 능력 상호작용 검사 함수
function checkNightActionsComplete(room) {
    const alivePlayers = room.players.filter(p => p.isAlive);
    
    const needsMafia = alivePlayers.some(p => p.role === 'mafia' || p.role === 'chameleon');
    const needsDoctor = alivePlayers.some(p => p.role === 'doctor');
    const needsPolice = alivePlayers.some(p => p.role === 'police');
    const needsReporter = alivePlayers.some(p => p.role === 'reporter' && (!room.cooldowns[p.id] || room.cooldowns[p.id] === 0));

    if (needsMafia && !room.actions.mafia) return false;
    if (needsDoctor && !room.actions.doctor) return false;
    if (needsPolice && !room.actions.police) return false;
    if (needsReporter && !room.actions.reporter && !room.actions.reporterSkipped) return false;

    processNightResolution(room);
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
            actions: { mafia: null, doctor: null, police: null, reporter: null, reporterSkipped: false },
            votes: {},
            cooldowns: {}
        };
        socket.emit('roomCreated', { roomId });
    });

    // 2. 방 입장 (isMaster 누락 해결)
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', '방이 존재하지 않습니다.');
        if (room.players.find(p => p.id === socket.id)) return;

        socket.join(roomId);
        
        // index.html 호환을 위해 객체 안에 직접 isMaster를 명시해 줍니다.
        const isMaster = (room.players.length === 0 || room.masterId === socket.id);
        room.players.push({ id: socket.id, username, role: null, isAlive: true, isMaster: isMaster });
        
        io.to(roomId).emit('roomData', room);
    });

    // 3. 설정 변경 동기화 (모든 유저 실시간 연동)
    socket.on('updateSettings', ({ roomId, settings }) => {
        if (rooms[roomId]) {
            rooms[roomId].settings = settings;
            io.to(roomId).emit('settingsUpdated', settings);
        }
    });

    // 4. 게임 시작 및 정밀 직업 분배
    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        room.status = 'night';
        const s = room.settings;
        let roles = [];
        
        // 룸 설정 기반 유연한 직업 배열 생성
        for(let i=0; i<(s.mafiaCount || 0); i++) roles.push('mafia');
        for(let i=0; i<(s.chameleonCount || 0); i++) roles.push('chameleon');
        for(let i=0; i<(s.doctorCount || 0); i++) roles.push('doctor');
        for(let i=0; i<(s.policeCount || 0); i++) roles.push('police');
        for(let i=0; i<(s.jesterCount || 0); i++) roles.push('jester');
        for(let i=0; i<(s.reporterCount || 0); i++) roles.push('reporter');
        
        // 모자란 자리는 시민으로 채우기
        while (roles.length < room.players.length) roles.push('citizen');
        roles.sort(() => Math.random() - 0.5); // 랜덤 셔플

        room.players.forEach((p, i) => {
            p.role = roles[i];
            p.isAlive = true;
            io.to(p.id).emit('assignRole', { role: p.role });
        });

        room.actions = { mafia: null, doctor: null, police: null, reporter: null, reporterSkipped: false };
        room.votes = {};
        room.cooldowns = {};

        io.to(roomId).emit('gameStarted', { status: room.status, players: room.players, cooldowns: room.cooldowns });
    });

    // 5. 채팅 메커니즘 (인게임 밤 비밀회의/낮 토론 완벽 구현)
    socket.on('sendMessage', ({ roomId, message, username, type }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (type === 'game') {
            if (room.status === 'night') {
                // 밤에는 마피아 진영끼리만 귓속말 형태(isSecret)로 전송
                if (player.role === 'mafia' || player.role === 'chameleon') {
                    room.players.forEach(p => {
                        if (p.role === 'mafia' || p.role === 'chameleon') {
                            io.to(p.id).emit('receiveMessage', { username, message, type, isSecret: true });
                        }
                    });
                }
            } else {
                if (player.isAlive) { // 생존자만 낮에 대화 가능
                    io.to(roomId).emit('receiveMessage', { username, message, type, isSecret: false });
                }
            }
        } else {
            // 대기실 전체 채팅
            io.to(roomId).emit('receiveMessage', { username, message, type, isSecret: false });
        }
    });

    // 6. 밤 상호작용 관련 액션 모음
    socket.on('mafiaAction', ({ roomId, targetId }) => {
        if (rooms[roomId]) { rooms[roomId].actions.mafia = targetId; checkNightActionsComplete(rooms[roomId]); }
    });
    socket.on('doctorAction', ({ roomId, targetId }) => {
        if (rooms[roomId]) { rooms[roomId].actions.doctor = targetId; checkNightActionsComplete(rooms[roomId]); }
    });
    socket.on('policeAction', ({ roomId, targetId }) => {
        if (rooms[roomId]) { rooms[roomId].actions.police = targetId; checkNightActionsComplete(rooms[roomId]); }
    });
    socket.on('reporterAction', ({ roomId, targetId }) => {
        if (rooms[roomId]) { rooms[roomId].actions.reporter = targetId; checkNightActionsComplete(rooms[roomId]); }
    });
    socket.on('reporterSkip', ({ roomId }) => {
        if (rooms[roomId]) { rooms[roomId].actions.reporterSkipped = true; checkNightActionsComplete(rooms[roomId]); }
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
            // 모든 생존자 투표 완료 시 정산 진행
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

                    // 제스터 승리 체크 (낮 처형 시 제스터 단독 승리)
                    if (executed.role === 'jester') {
                        io.to(room.id).emit('gameOver', { winner: 'jester', winnerName: executed.username });
                        delete rooms[room.id];
                        return;
                    }
                }
            }

            if (checkWinConditions(room)) return;

            // 기자 쿨다운 감소 차감
            Object.keys(room.cooldowns).forEach(id => { if (room.cooldowns[id] > 0) room.cooldowns[id]--; });

            // 다시 밤 단계로 진입 및 초기화
            room.status = 'night';
            room.actions = { mafia: null, doctor: null, police: null, reporter: null, reporterSkipped: false };
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
                
                // 방장이 나갔을 때 다른 사람에게 방장 위임
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