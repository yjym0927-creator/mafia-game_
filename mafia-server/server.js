const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// 루트 경로 시 index.html 반환
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 게임 방 데이터 저장 구조
const rooms = {};

// 방 코드 생성 함수 (6자리 대문자 알파벳)
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// 직업 분배 함수 (셔플 알고리즘)
function assignRoles(room) {
    const settings = room.settings;
    const rolePool = [];

    // 설정된 수만큼 직업 풀에 추가
    for (let i = 0; i < settings.mafiaCount; i++) rolePool.push('mafia');
    for (let i = 0; i < settings.chameleonCount; i++) rolePool.push('chameleon');
    for (let i = 0; i < settings.doctorCount; i++) rolePool.push('doctor');
    for (let i = 0; i < settings.policeCount; i++) rolePool.push('police');
    for (let i = 0; i < settings.jesterCount; i++) rolePool.push('jester');
    for (let i = 0; i < settings.reporterCount; i++) rolePool.push('reporter');

    // 남는 자리는 전부 시민으로 채움
    const remaining = room.players.length - rolePool.length;
    for (let i = 0; i < remaining; i++) {
        rolePool.push('citizen');
    }

    // 직업 풀 무작위 셔플
    for (let i = rolePool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
    }

    // 플레이어들에게 직업 할당 및 클라이언트에 개별 전송
    room.players.forEach((player, index) => {
        player.role = rolePool[index];
        player.isAlive = true;
        io.to(player.id).emit('assignRole', { role: player.role });
    });
}

// 게임 종료 후 방 데이터 초기화 (유저 명단 유지)
function resetRoomForNextGame(room) {
    room.status = 'waiting'; // 상태를 다시 대기실로 변경
    
    // 플레이어들의 게임 내 정보만 리셋 (id, username, isMaster 상태는 유지)
    room.players.forEach(p => {
        p.role = '';
        p.isAlive = true;
    });

    // 모든 임시 데이터 비우기
    room.nightActions = { mafiaVotes: {}, chameleonTarget: null, doctorTarget: null, policeTarget: null, reporterTarget: null, reporterSkipped: false };
    room.dayVotes = {};
    room.cooldowns = {};
    room.lastChatTime = {};

    // 대기실 상태의 방 정보 브로드캐스팅 (index.html에서 대기실 화면으로 전환되도록 유도)
    io.to(room.id).emit('roomData', room);
}

// 승리 조건 체크 함수
function checkGameOver(room) {
    const alivePlayers = room.players.filter(p => p.isAlive);
    const mafiaFaction = alivePlayers.filter(p => p.role === 'mafia' || p.role === 'chameleon');
    const citizenFaction = alivePlayers.filter(p => p.role !== 'mafia' && p.role !== 'chameleon' && p.role !== 'jester');

    // 1. 마피아 진영이 전멸한 경우 -> 시민 승리
    if (mafiaFaction.length === 0) {
        io.to(room.id).emit('gameOver', { winner: 'citizen' });
        resetRoomForNextGame(room); // 방 폭파 대신 대기실 상태로 초기화
        return true;
    }

    // 2. 마피아 진영의 수가 생존한 시민 진영(제스터 제외)의 수보다 같거나 많아진 경우 -> 마피아 승리
    if (mafiaFaction.length >= citizenFaction.length) {
        io.to(room.id).emit('gameOver', { winner: 'mafia' });
        resetRoomForNextGame(room); // 방 폭파 대신 대기실 상태로 초기화
        return true;
    }

    return false;
}

io.on('connection', (socket) => {
    // 1. 새로운 방 만들기
    socket.on('createRoom', ({ username }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId,
            masterId: socket.id,
            status: 'waiting', // waiting, night, day
            players: [],
            settings: {
                maxPlayers: 8,
                mafiaCount: 0,
                chameleonCount: 1,
                doctorCount: 1,
                policeCount: 1,
                jesterCount: 0,
                reporterCount: 0,
                antiSpam: false
            },
            nightActions: { mafiaVotes: {}, chameleonTarget: null, doctorTarget: null, policeTarget: null, reporterTarget: null, reporterSkipped: false },
            dayVotes: {},
            cooldowns: {},
            lastChatTime: {}
        };
        socket.emit('roomCreated', { roomId });
    });

    // 2. 방 코드로 입장하기
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', '존재하지 않는 방 코드입니다.');
        if (room.status !== 'waiting') return socket.emit('errorMessage', '이미 게임이 시작된 방입니다.');
        if (room.players.length >= room.settings.maxPlayers) return socket.emit('errorMessage', '방이 가득 찼습니다.');
        
        // 닉네임 중복 방지 처리
        let finalUsername = username;
        let count = 1;
        while (room.players.some(p => p.username === finalUsername)) {
            finalUsername = `${username}_${count++}`;
        }

        const isMaster = room.masterId === socket.id;
        room.players.push({
            id: socket.id,
            username: finalUsername,
            isMaster: isMaster,
            role: '',
            isAlive: true
        });

        socket.join(roomId);
        io.to(roomId).emit('roomData', room);
        io.to(roomId).emit('settingsUpdated', room.settings);
    });

    // [추가] 2-B. 방장의 플레이어 강퇴(Kick) 기능
    socket.on('kickPlayer', ({ roomId, targetPlayerId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        // 요청한 사람이 방장인지 확인
        if (room.masterId !== socket.id) {
            return socket.emit('errorMessage', '방장만 플레이어를 강퇴할 수 있습니다.');
        }

        const targetIndex = room.players.findIndex(p => p.id === targetPlayerId);
        if (targetIndex !== -1) {
            const kickedPlayerName = room.players[targetIndex].username;
            
            // 강퇴당하는 사람에게 알림 발송 후 방(룸)에서 이탈 처리
            io.to(targetPlayerId).emit('kicked', '방장에 의해 방에서 강퇴당했습니다.');
            
            const targetSocket = io.sockets.sockets.get(targetPlayerId);
            if (targetSocket) {
                targetSocket.leave(roomId);
            }

            // 배열에서 유저 삭제
            room.players.splice(targetIndex, 1);

            // 채팅창에 강퇴 공지 알림 및 방 데이터 갱신 전파
            io.to(roomId).emit('systemMessage', `❌ [ ${kickedPlayerName} ] 님이 방장에 의해 강퇴되었습니다.`);
            io.to(roomId).emit('roomData', room);
        }
    });

    // 3. 방장 설정 변경 전파
    socket.on('updateSettings', ({ roomId, settings }) => {
        const room = rooms[roomId];
        if (!room || room.masterId !== socket.id) return;
        room.settings = settings;
        socket.to(roomId).emit('settingsUpdated', settings);
    });

    // 4. 게임 시작 처리
    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.masterId !== socket.id) return;

        const totalSettingRoles = room.settings.mafiaCount + room.settings.chameleonCount + room.settings.doctorCount + room.settings.policeCount + room.settings.jesterCount + room.settings.reporterCount;
        if (totalSettingRoles > room.players.length) {
            return socket.emit('errorMessage', '설정된 직업 수가 현재 플레이어 수보다 많습니다. 세팅을 조정해주세요.');
        }

        room.status = 'night';
        assignRoles(room);

        // 모든 유저 쿨다운 초기화
        room.cooldowns = {};
        room.players.forEach(p => room.cooldowns[p.id] = 0);

        // 밤 액션 초기화
        room.nightActions = { mafiaVotes: {}, chameleonTarget: null, doctorTarget: null, policeTarget: null, reporterTarget: null, reporterSkipped: false };

        io.to(roomId).emit('gameStarted', {
            status: 'night',
            players: room.players,
            cooldowns: room.cooldowns
        });
    });

    // 5. 채팅 메시지 처리
    socket.on('sendMessage', ({ roomId, message, username, type }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (type === 'game' && player && !player.isAlive) return; // 사망자 채팅 금지

        if (room.settings.antiSpam && room.status === 'day') {
            const now = Date.now();
            const lastTime = room.lastChatTime[socket.id] || 0;
            if (now - lastTime < 1000) {
                return socket.emit('errorMessage', '⚠️ 도배 방지: 1초 후에 다시 입력할 수 있습니다.');
            }
            room.lastChatTime[socket.id] = now;
        }

        if (room.status === 'night' && type === 'game') {
            if (player && (player.role === 'mafia' || player.role === 'chameleon')) {
                room.players.forEach(p => {
                    if (p.role === 'mafia' || p.role === 'chameleon') {
                        io.to(p.id).emit('receiveMessage', { username: player.username, message, type, isSecret: true });
                    }
                });
            }
            return;
        }

        io.to(roomId).emit('receiveMessage', { username, message, type, isSecret: false });
    });

    // 6. 밤 능력 사용 접수
    socket.on('mafiaAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || (player.role !== 'mafia' && player.role !== 'chameleon')) return;

        room.nightActions.mafiaVotes[socket.id] = targetId;
        checkNightTurnEnd(roomId);
    });

    socket.on('chameleonAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || player.role !== 'chameleon') return;

        room.nightActions.chameleonTarget = targetId === 'skip' ? null : targetId;
        checkNightTurnEnd(roomId);
    });

    socket.on('doctorAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || player.role !== 'doctor') return;

        room.nightActions.doctorTarget = targetId;
        checkNightTurnEnd(roomId);
    });

    socket.on('policeAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || player.role !== 'police') return;

        room.nightActions.policeTarget = targetId;
        checkNightTurnEnd(roomId);
    });

    socket.on('reporterAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || player.role !== 'reporter') return;
        if (room.cooldowns[socket.id] > 0) return;

        room.nightActions.reporterTarget = targetId;
        checkNightTurnEnd(roomId);
    });

    socket.on('reporterSkip', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || player.role !== 'reporter') return;

        room.nightActions.reporterSkipped = true;
        checkNightTurnEnd(roomId);
    });

    function checkNightTurnEnd(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        const alivePlayers = room.players.filter(p => p.isAlive);
        const hasMafiaGroup = alivePlayers.some(p => p.role === 'mafia' || p.role === 'chameleon');
        const hasChameleon = alivePlayers.some(p => p.role === 'chameleon');
        const hasDoctor = alivePlayers.some(p => p.role === 'doctor');
        const hasPolice = alivePlayers.some(p => p.role === 'police');
        const hasReporter = alivePlayers.some(p => p.role === 'reporter');

        if (hasMafiaGroup) {
            const totalMafiaGroupCount = alivePlayers.filter(p => p.role === 'mafia' || p.role === 'chameleon').length;
            if (Object.keys(room.nightActions.mafiaVotes).length < totalMafiaGroupCount) return;
        }
        if (hasChameleon && room.nightActions.chameleonTarget === undefined) return;
        if (hasDoctor && !room.nightActions.doctorTarget) return;
        if (hasPolice && !room.nightActions.policeTarget) return;
        if (hasReporter && room.cooldowns[room.players.find(p => p.role === 'reporter' && p.isAlive)?.id] === 0) {
            if (!room.nightActions.reporterTarget && !room.nightActions.reporterSkipped) return;
        }

        room.status = 'day';
        let logMessages = [];
        let reporterNewsText = "";

        let finalMafiaKillTargetId = null;
        const votes = Object.values(room.nightActions.mafiaVotes);
        if (votes.length > 0) {
            const frequency = {};
            votes.forEach(v => frequency[v] = (frequency[v] || 0) + 1);
            finalMafiaKillTargetId = Object.keys(frequency).reduce((a, b) => frequency[a] >= frequency[b] ? a : b);
        }

        let isSavedByDoctor = false;
        if (finalMafiaKillTargetId && finalMafiaKillTargetId === room.nightActions.doctorTarget) {
            isSavedByDoctor = true;
        }

        let actualKillSuccess = false;
        if (finalMafiaKillTargetId) {
            const targetPlayer = room.players.find(p => p.id === finalMafiaKillTargetId);
            if (targetPlayer && targetPlayer.isAlive) {
                if (isSavedByDoctor) {
                    logMessages.push(`의사의 눈부신 활약으로 밤사이 아무도 희생되지 않았습니다!`);
                } else {
                    targetPlayer.isAlive = false;
                    logMessages.push(`💀 밤사이 주민 [ ${targetPlayer.username} ] 님이 마피아의 습격을 받아 참혹하게 사망했습니다.`);
                    actualKillSuccess = true;
                }
            }
        } else {
            logMessages.push(`밤사이 아무 일도 일어나지 않았습니다.`);
        }

        if (actualKillSuccess && hasChameleon && room.nightActions.chameleonTarget) {
            const chameleonPlayer = room.players.find(p => p.role === 'chameleon' && p.isAlive);
            const swapTargetPlayer = room.players.find(p => p.id === room.nightActions.chameleonTarget);

            if (chameleonPlayer && swapTargetPlayer && swapTargetPlayer.isAlive) {
                const oldChameleonName = chameleonPlayer.username;
                const oldTargetName = swapTargetPlayer.username;

                chameleonPlayer.username = oldTargetName;
                swapTargetPlayer.username = oldChameleonName;

                logMessages.push(`⚠️ [카멜레온 교란] 카멜레온이 신분을 위조하여 생존자 중 한 명과 이름을 바꾸었습니다!`);
            }
        }

        if (hasPolice && room.nightActions.policeTarget) {
            const policeTargetPlayer = room.players.find(p => p.id === room.nightActions.policeTarget);
            const policePlayer = room.players.find(p => p.role === 'police' && p.isAlive);

            if (policeTargetPlayer && policeTargetPlayer.isAlive && policePlayer) {
                if (policeTargetPlayer.role === 'mafia' || policeTargetPlayer.role === 'chameleon') {
                    policeTargetPlayer.isAlive = false;
                    logMessages.push(`🚨 [경찰 출동] 경찰의 정밀 사격으로 마피아 진영인 [ ${policeTargetPlayer.username} ]을 처단했습니다!`);
                } else {
                    policePlayer.isAlive = false;
                    logMessages.push(`🚨 [경찰 오사] 경찰이 선량한 시민을 저격하는 실책을 범해, 자책감으로 스스로 목숨을 끊었습니다.`);
                }
            }
        }

        if (hasReporter && room.nightActions.reporterTarget) {
            const reporterPlayer = room.players.find(p => p.role === 'reporter' && p.isAlive);
            const reporterTargetPlayer = room.players.find(p => p.id === room.nightActions.reporterTarget);

            if (reporterPlayer && reporterTargetPlayer) {
                const roleKrs = { mafia: '마피아 🕵️', chameleon: '카멜레온 🦎', doctor: '의사 💉', police: '경찰 🚨', citizen: '시민 🧍', jester: '제스터 🤡', reporter: '기자 📰' };
                reporterNewsText = `📰 [기자 특종 뉴스]\n기자가 목숨을 걸고 취재한 결과, [ ${reporterTargetPlayer.username} ] 님의 본래 신분은 법적으로 [[ ${roleKrs[reporterTargetPlayer.role]} ]] 임이 입증되었습니다!`;
                room.cooldowns[reporterPlayer.id] = 3; 
            }
        }

        room.players.forEach(p => {
            if (room.cooldowns[p.id] > 0) room.cooldowns[p.id]--;
        });

        const gameOverTriggered = checkGameOver(room);

        if (!gameOverTriggered) {
            room.dayVotes = {};
            io.to(roomId).emit('dayStarted', {
                status: 'day',
                message: logMessages.join('\n'),
                reporterNews: reporterNewsText,
                players: room.players,
                cooldowns: room.cooldowns
            });
        }
    }

    // 7. 낮 처형 투표 시스템 접수
    socket.on('dayVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'day') return;

        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !voter.isAlive) return;

        room.dayVotes[socket.id] = targetId;

        let targetName = "투표 건너뛰기 ⏩";
        if (targetId !== 'skip') {
            const target = room.players.find(p => p.id === targetId);
            if (target) targetName = target.username;
        }

        io.to(roomId).emit('voteProgress', { voterName: voter.username, targetName });

        const alivePlayers = room.players.filter(p => p.isAlive);
        if (Object.keys(room.dayVotes).length === alivePlayers.length) {
            processDayVoteResult(roomId);
        }
    });

    function processDayVoteResult(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        const voteValues = Object.values(room.dayVotes);
        const frequency = {};
        voteValues.forEach(v => frequency[v] = (frequency[v] || 0) + 1);

        let maxVotes = 0;
        let finalTargetId = null;
        let isTie = false;

        Object.keys(frequency).forEach(id => {
            if (frequency[id] > maxVotes) {
                maxVotes = frequency[id];
                finalTargetId = id;
                isTie = false;
            } else if (frequency[id] === maxVotes) {
                isTie = true;
            }
        });

        let resultMessage = "";

        if (isTie || finalTargetId === 'skip' || !finalTargetId) {
            resultMessage = "의견이 분분하거나 투표 스킵 의견이 많아, 낮 시간 동안 아무도 처형되지 않고 밤이 찾아옵니다.";
        } else {
            const executedPlayer = room.players.find(p => p.id === finalTargetId);
            if (executedPlayer && executedPlayer.isAlive) {
                executedPlayer.isAlive = false;
                resultMessage = `⚖️ 주민들의 다수결 투표에 의해 [ ${executedPlayer.username} ] 님이 마피아로 몰려 단두대에서 처형되었습니다.`;

                if (executedPlayer.role === 'jester') {
                    io.to(roomId).emit('gameOver', { winner: 'jester', winnerName: executedPlayer.username });
                    resetRoomForNextGame(room); // 제스터 승리 시 대기실로 초기화
                    return;
                }
            }
        }

        const gameOverTriggered = checkGameOver(room);

        if (!gameOverTriggered) {
            room.status = 'night';
            room.nightActions = { mafiaVotes: {}, chameleonTarget: undefined, doctorTarget: null, policeTarget: null, reporterTarget: null, reporterSkipped: false };
            
            io.to(roomId).emit('nightStarted', {
                status: 'night',
                message: resultMessage,
                players: room.players,
                cooldowns: room.cooldowns
            });
        }
    }

    // 8. 연결 끊김(Disconnect) 예외 처리
    socket.on('disconnect', () => {
        let targetRoomId = null;

        Object.keys(rooms).forEach(roomId => {
            const index = rooms[roomId].players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                targetRoomId = roomId;
                rooms[roomId].players.splice(index, 1);
            }
        });

        if (targetRoomId) {
            const room = rooms[targetRoomId];
            
            if (room.players.length === 0) {
                delete rooms[targetRoomId];
                return;
            }

            if (room.masterId === socket.id && room.players.length > 0) {
                room.masterId = room.players[0].id;
                room.players[0].isMaster = true;
            }

            if (room.status === 'waiting') {
                io.to(targetRoomId).emit('roomData', room);
            } else {
                io.to(targetRoomId).emit('systemMessage', `유저 한 명이 연결을 해제하여 탈주 처리되었습니다.`);
                const gameOverTriggered = checkGameOver(room);
                if (!gameOverTriggered) {
                    io.to(targetRoomId).emit('dayStarted', {
                        status: room.status,
                        message: "플레이어 탈주로 게임 인원 변동이 생겼습니다.",
                        reporterNews: "",
                        players: room.players,
                        cooldowns: room.cooldowns
                    });
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Mafia server running on port *:${PORT}`);
});
