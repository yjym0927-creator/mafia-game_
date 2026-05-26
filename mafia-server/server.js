// server.js
const express = require('express');
const http = require('http'); // 👈 클라우드 호스팅 호환을 위해 기본 http 모듈 로드
const fs = require('fs');       
const { Server } = require('socket.io');
const path = require('path');

const app = express();

// 🌐 [클라우드 강제 패치] Render 인프라와의 완벽한 호환을 위해 무조건 HTTP 모드로 가동합니다.
// (Render 자체 인프라가 겉면을 HTTPS 보안 연결로 안전하게 감싸줍니다.)
let server = http.createServer(app);
console.log("🌐 [CLOUD] Render 인프라 호환형 HTTP 모드로 가동됩니다.");

// 웹소켓 CORS 설정 통합
const io = new Server(server, { 
    cors: { origin: "*" } 
});

// 정적 파일(HTML, CSS, JS) 서비스 폴더 지정
app.use(express.static('public')); 

// 게임 데이터 관리를 위한 전역 객체 변수들
const rooms = {}; 
const roomActions = {}; 
const roomVotes = {};   
const reporterCooldowns = {}; 
const chameleonPending = {}; 
const lastMessageTime = {}; 

// 무작위 6자리 방 코드 생성 함수
function generateRoomCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 6; i++) {
            const randomIndex = Math.floor(Math.random() * characters.length);
            code += characters.charAt(randomIndex);
        }
    } while (rooms[code]);
    return code;
}

// 웹소켓 이벤트 핸들러 시작
io.on('connection', (socket) => {
    console.log(`유저 접속 성공 (Socket ID): ${socket.id}`);

    // 1. 방 만들기 이벤트
    socket.on('createRoom', ({ username }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId,
            players: [],
            status: 'waiting',
            masterId: socket.id,
            settings: { 
                maxPlayers: 8, 
                mafiaCount: 1, 
                doctorCount: 1, 
                policeCount: 1, 
                jesterCount: 0, 
                reporterCount: 0, 
                chameleonCount: 0, 
                antiSpam: false 
            }
        };
        socket.emit('roomCreated', { roomId });
    });

    // 2. 방 입장 이벤트
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', '존재하지 않는 방 코드입니다.');
        if (room.status !== 'waiting') return socket.emit('errorMessage', '이미 게임이 시작된 방입니다.');
        if (room.players.length >= room.settings.maxPlayers) return socket.emit('errorMessage', `방이 가득 찼습니다.`);

        socket.join(roomId);

        const player = {
            id: socket.id,
            username,
            role: null,
            isAlive: true,
            isMaster: room.masterId === socket.id
        };

        room.players.push(player);
        io.to(roomId).emit('roomData', room);
    });

    // 3. 방장의 게임 옵션 변경 적용
    socket.on('updateSettings', ({ roomId, settings }) => {
        const room = rooms[roomId];
        if (!room || room.masterId !== socket.id) return;
        room.settings = settings;
        io.to(roomId).emit('settingsUpdated', room.settings);
    });

    // 4. 게임 시작 및 직업 분배
    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        const players = room.players;
        const { mafiaCount, doctorCount, policeCount, jesterCount, reporterCount, chameleonCount } = room.settings;
        const totalSpecialRoles = Number(mafiaCount) + Number(doctorCount) + Number(policeCount) + Number(jesterCount) + Number(reporterCount) + Number(chameleonCount);

        if (players.length < totalSpecialRoles) {
            return socket.emit('errorMessage', `지정된 특수 직업 수보다 대기실 인원이 적습니다.`);
        }

        room.status = 'night';
        reporterCooldowns[roomId] = {};
        delete chameleonPending[roomId];

        // 직업 카드 풀 구성
        const roles = [];
        for (let i = 0; i < mafiaCount; i++) roles.push('mafia');
        for (let i = 0; i < chameleonCount; i++) roles.push('chameleon'); 
        for (let i = 0; i < doctorCount; i++) roles.push('doctor');
        for (let i = 0; i < policeCount; i++) roles.push('police');
        for (let i = 0; i < jesterCount; i++) roles.push('jester');
        for (let i = 0; i < reporterCount; i++) roles.push('reporter');
        while (roles.length < players.length) roles.push('citizen');
        
        // 셔플 알고리즘 적용
        roles.sort(() => Math.random() - 0.5);

        players.forEach((player, index) => {
            player.role = roles[index];
            player.isAlive = true;
            io.to(player.id).emit('assignRole', { role: player.role });
            
            if (player.role === 'reporter') {
                reporterCooldowns[roomId][player.id] = 0; // 기자 쿨타임 초기화
            }
        });

        io.to(roomId).emit('gameStarted', { status: room.status, players: room.players, cooldowns: reporterCooldowns[roomId] });
    });

    // 5. 밤 페이즈 - 마피아/카멜레온 타겟 지정
    socket.on('mafiaAction', ({ roomId, targetId }) => {
        if (!roomActions[roomId]) roomActions[roomId] = {};
        roomActions[roomId].mafiaTarget = targetId;
        roomActions[roomId].mafiaId = socket.id; 
        checkNightResult(roomId);
    });

    // 6. 밤 페이즈 - 의사 힐 타겟 지정
    socket.on('doctorAction', ({ roomId, targetId }) => {
        if (!roomActions[roomId]) roomActions[roomId] = {};
        roomActions[roomId].doctorTarget = targetId;
        checkNightResult(roomId);
    });

    // 7. 밤 페이즈 - 경찰 조사 타겟 지정
    socket.on('policeAction', ({ roomId, targetId }) => {
        if (!roomActions[roomId]) roomActions[roomId] = {};
        roomActions[roomId].policeTarget = targetId;
        checkNightResult(roomId);
    });

    // 8. 밤 페이즈 - 기자 취재 액션
    socket.on('reporterAction', ({ roomId, targetId }) => {
        if (!roomActions[roomId]) roomActions[roomId] = {};
        const currentCooldown = reporterCooldowns[roomId] ? reporterCooldowns[roomId][socket.id] : 0;
        if (currentCooldown > 0) return socket.emit('errorMessage', '아직 기사를 작성할 수 없습니다. (쿨타임 상태)');

        roomActions[roomId].reporterTarget = targetId;
        roomActions[roomId].reporterId = socket.id;
        checkNightResult(roomId);
    });

    // 9. 기자 패스 선택
    socket.on('reporterSkip', ({ roomId }) => {
        if (!roomActions[roomId]) roomActions[roomId] = {};
        roomActions[roomId].reporterTarget = 'skip';
        checkNightResult(roomId);
    });

    // 10. 모든 밤 능력이 상호 수집되었는지 연산 처리하는 메인 알고리즘
    function checkNightResult(roomId) {
        const room = rooms[roomId];
        const actions = roomActions[roomId];
        if (!room) return;

        const hasAliveMafia = room.players.some(p => (p.role === 'mafia' || p.role === 'chameleon') && p.isAlive);
        const hasAliveDoctor = room.players.some(p => p.role === 'doctor' && p.isAlive);
        const hasAlivePolice = room.players.some(p => p.role === 'police' && p.isAlive);
        const hasAliveReporter = room.players.some(p => p.role === 'reporter' && p.isAlive);

        const mafiaReady = !hasAliveMafia || (actions && actions.mafiaTarget);
        const doctorReady = !hasAliveDoctor || (actions && actions.doctorTarget);
        const policeReady = !hasAlivePolice || (actions && actions.policeTarget);
        const reporterReady = !hasAliveReporter || (actions && actions.reporterTarget);

        if (mafiaReady && doctorReady && policeReady && reporterReady) {
            const executioner = room.players.find(p => p.id === actions.mafiaId);
            let isChameleonKillSuccess = false;
            let targetDeadId = null;

            if (actions.mafiaTarget && actions.mafiaTarget !== actions.doctorTarget) {
                const deadPlayer = room.players.find(p => p.id === actions.mafiaTarget);
                if (deadPlayer) {
                    targetDeadId = deadPlayer.id;
                    if (executioner && executioner.role === 'chameleon') {
                        isChameleonKillSuccess = true;
                    }
                }
            }

            // 카멜레온의 킬이 성립한 경우: 변장 UI 대기 모드로 진입 (전환 보류)
            if (isChameleonKillSuccess && targetDeadId) {
                chameleonPending[roomId] = {
                    chameleonId: executioner.id,
                    deadId: targetDeadId,
                    savedActions: { ...actions } 
                };
                io.to(executioner.id).emit('chameleonSkillTrigger', {
                    players: room.players.filter(p => p.isAlive && p.id !== executioner.id)
                });
                return; 
            }

            proceedToDay(roomId, actions);
        }
    }

    // 11. 카멜레온 이름 변조 최종 확정 및 낮으로 변환
    socket.on('chameleonExchangeName', ({ roomId, targetId }) => {
        const pending = chameleonPending[roomId];
        const room = rooms[roomId];
        if (!pending || !room) return;

        const chameleonPlayer = room.players.find(p => p.id === pending.chameleonId);
        const targetPlayer = room.players.find(p => p.id === targetId);

        if (chameleonPlayer && targetPlayer && targetPlayer.isAlive) {
            const tempName = chameleonPlayer.username;
            chameleonPlayer.username = targetPlayer.username;
            targetPlayer.username = tempName;

            io.to(chameleonPlayer.id).emit('systemMessage', `🟢 카멜레온 변장 성공! 이제 당신의 이름은 [ ${chameleonPlayer.username} ] 입니다.`);
            io.to(targetId).emit('systemMessage', `⚠️ 알 수 없는 기운에 의해 당신의 이름이 [ ${targetPlayer.username} ] 으로 변경되었습니다!`);
        }

        const savedActions = pending.savedActions;
        delete chameleonPending[roomId];
        proceedToDay(roomId, savedActions);
    });

    // 12. 낮으로 페이즈 전환 연산 처리
    function proceedToDay(roomId, actions) {
        const room = rooms[roomId];
        if (!room) return;

        room.status = 'day';
        let deadMessages = [];
        let reporterMessage = "";

        // 마피아 습격 결과 대조
        if (actions.mafiaTarget && actions.mafiaTarget !== actions.doctorTarget) {
            const deadPlayer = room.players.find(p => p.id === actions.mafiaTarget);
            if (deadPlayer) {
                deadPlayer.isAlive = false;
                deadMessages.push(`[ ${deadPlayer.username} ] 님이 마피아의 습격으로 사망했습니다.`);
            }
        }

        // 경찰 저격 연산 결과 대조
        if (actions.policeTarget) {
            const targetPlayer = room.players.find(p => p.id === actions.policeTarget);
            if (targetPlayer && targetPlayer.isAlive && targetPlayer.role === 'mafia') {
                targetPlayer.isAlive = false;
                deadMessages.push(`🚨 경찰이 밤중에 마피아를 저격했습니다! 사망자: [ ${targetPlayer.username} ]`);
            }
        }

        // 기자 취재 기사 발행 처리
        if (actions.reporterTarget && actions.reporterTarget !== 'skip') {
            const targetPlayer = room.players.find(p => p.id === actions.reporterTarget);
            if (targetPlayer) {
                let roleKorean = { mafia: '마피아🕵️', chameleon: '카멜레온🦎', doctor: '의사💉', police: '경찰🚨', citizen: '시민🧍', jester: '제스터🤡', reporter: '기자📰' }[targetPlayer.role];
                reporterMessage = `📰 [특종] 기자의 속보!\n👉 플레이어 [ ${targetPlayer.username} ] 님의 진짜 직업은 [ ${roleKorean} ] 입니다!`;
                if (reporterCooldowns[roomId] && actions.reporterId) {
                    reporterCooldowns[roomId][actions.reporterId] = 2; // 기사 작성 시 패널티 쿨타임 2 부여
                }
            }
        }

        // 기자가 활동을 유보하거나 안 했을 때 쿨타임 감소 연산
        if (!actions.reporterTarget || actions.reporterTarget === 'skip') {
            if (reporterCooldowns[roomId]) {
                for (const repId in reporterCooldowns[roomId]) {
                    if (reporterCooldowns[roomId][repId] > 0) reporterCooldowns[roomId][repId]--;
                }
            }
        }

        // 연산 버퍼 비우기
        delete roomActions[roomId];
        if (roomVotes[roomId]) delete roomVotes[roomId];

        let resultNotice = deadMessages.length > 0 ? deadMessages.join('\n') : "지난밤은 평화로웠습니다. 아무도 죽지 않았습니다.";

        io.to(roomId).emit('dayStarted', {
            status: room.status,
            message: resultNotice,
            reporterNews: reporterMessage,
            players: room.players,
            cooldowns: reporterCooldowns[roomId]
        });

        checkVictory(roomId);
    }

    // 13. 낮 투표 이벤트 수집
    socket.on('dayVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'day') return;

        if (!roomVotes[roomId]) roomVotes[roomId] = {};
        roomVotes[roomId][socket.id] = targetId;

        const alivePlayers = room.players.filter(p => p.isAlive);
        const votedCount = Object.keys(roomVotes[roomId]).length;

        const voter = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);
        io.to(roomId).emit('voteProgress', { voterName: voter.username, targetName: targetId === 'skip' ? '투표 건너뛰기' : target.username });

        if (votedCount >= alivePlayers.length) {
            handleVoteResult(roomId);
        }
    });

    // 14. 투표 개표 및 심판 처형 실행
    function handleVoteResult(roomId) {
        const room = rooms[roomId];
        const votes = roomVotes[roomId];
        if (!room) return;

        const voteCounts = {};
        let skipCount = 0;

        Object.values(votes).forEach(targetId => {
            if (targetId === 'skip') skipCount++;
            else voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        });

        let maxVotes = skipCount;
        let executionTargetId = 'skip';
        let isTie = false;

        for (const [targetId, count] of Object.entries(voteCounts)) {
            if (count > maxVotes) {
                maxVotes = count;
                executionTargetId = targetId;
                isTie = false;
            } else if (count === maxVotes) {
                isTie = true;
            }
        }

        let voteResultMessage = "";

        if (isTie || executionTargetId === 'skip') {
            voteResultMessage = "⚖️ 투표가 동률이거나 과반수가 건너뛰어 처형이 무산되었습니다.";
        } else {
            const deadPlayer = room.players.find(p => p.id === executionTargetId);
            if (deadPlayer) {
                deadPlayer.isAlive = false;
                
                // 🤡 제스터 처형 승리 체크 예외처리
                if (deadPlayer.role === 'jester') {
                    io.to(roomId).emit('gameOver', { winner: 'jester', winnerName: deadPlayer.username });
                    room.status = 'waiting';
                    delete roomVotes[roomId];
                    return;
                }

                let roleKorean = { mafia: '마피아', chameleon: '카멜레온', doctor: '의사', police: '경찰', citizen: '시민', reporter: '기자' }[deadPlayer.role];
                voteResultMessage = `💀 투표 결과, 주민들의 심판으로 [ ${deadPlayer.username} ] 님이 처형되었습니다.\n(진짜 정체: [ ${roleKorean} ])`;
            }
        }

        delete roomVotes[roomId];

        if (checkVictory(roomId)) return;

        // 기자의 투표 단계가 지나면 연산 보정
        if (reporterCooldowns[roomId]) {
            for (const repId in reporterCooldowns[roomId]) {
                if (rooms[roomId].players.find(p => p.id === repId) && reporterCooldowns[roomId][repId] === 2) {
                    reporterCooldowns[roomId][repId] = 1;
                }
            }
        }

        room.status = 'night';
        io.to(roomId).emit('nightStarted', {
            status: room.status,
            message: voteResultMessage,
            players: room.players,
            cooldowns: reporterCooldowns[roomId]
        });
    }

    // 15. 승리 조건 감지 알고리즘
    function checkVictory(roomId) {
        const room = rooms[roomId];
        if (!room) return false;

        const mafiaCount = room.players.filter(p => (p.role === 'mafia' || p.role === 'chameleon') && p.isAlive).length;
        const citizenCount = room.players.filter(p => p.role !== 'mafia' && p.role !== 'chameleon' && p.role !== 'jester' && p.isAlive).length;

        if (mafiaCount === 0) {
            io.to(roomId).emit('gameOver', { winner: 'citizens' });
            room.status = 'waiting';
            return true;
        } else if (mafiaCount >= citizenCount) {
            io.to(roomId).emit('gameOver', { winner: 'mafia' });
            room.status = 'waiting';
            return true;
        }
        return false;
    }

    // 16. 실시간 채팅 제어 및 밤 단계 마피아 기밀 채팅 분리 연산
    socket.on('sendMessage', ({ roomId, message, username, type }) => {
        const room = rooms[roomId];
        if (!room) return;

        // 도배 방지 필터링 작동
        if (room.settings.antiSpam) {
            const now = Date.now();
            const lastTime = lastMessageTime[socket.id] || 0;
            if (now - lastTime < 1000) return socket.emit('systemMessage', '⚠️ 도배가 금지된 방입니다. (1초 제한)');
            lastMessageTime[socket.id] = now;
        }

        const sender = room.players.find(p => p.id === socket.id);

        // 밤 단계일 때의 전용 라우팅 연산
        if (type === 'game' && room.status === 'night') {
            if (sender && (sender.role === 'mafia' || sender.role === 'chameleon') && sender.isAlive) {
                room.players.forEach(p => {
                    if ((p.role === 'mafia' || p.role === 'chameleon') && p.isAlive) {
                        io.to(p.id).emit('receiveMessage', { 
                            username: `[🥷마피아 기밀] ${username}`, 
                            message, 
                            type,
                            isSecret: true 
                        });
                    }
                });
            }
            return; 
        }

        io.to(roomId).emit('receiveMessage', { username, message, type });
    });

    // 17. 유저 연결 해제 예외처리
    socket.on('disconnect', () => {
        delete lastMessageTime[socket.id];
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                if (room.players.length === 0) {
                    delete rooms[roomId];
                    if (roomActions[roomId]) delete roomActions[roomId];
                    if (roomVotes[roomId]) delete roomVotes[roomId];
                    if (reporterCooldowns[roomId]) delete reporterCooldowns[roomId];
                    if (chameleonPending[roomId]) delete chameleonPending[roomId];
                } else {
                    if (room.masterId === socket.id) {
                        room.masterId = room.players[0].id;
                        room.players[0].isMaster = true;
                    }
                    io.to(roomId).emit('roomData', room);
                }
                break;
            }
        }
    });
});

// 🌐 [포트 바인딩 핵심 패치] Render 인프라 호환을 위해 호스트 IP('0.0.0.0')를 제거하고 포트만 단독 바인딩합니다.
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 마피아 호스팅 네트워크 엔진 활성화 완료.`);
    console.log(`📡 현재 바인딩된 네트워크 포트 번호: [ ${PORT} ]`);
    console.log(`====================================================`);
});