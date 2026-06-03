const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// 루트 경로 시 index.html 반환 (index.html이 public 폴더에 있다고 가정)
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

// 승리 조건 체크 함수
function checkGameOver(room) {
    const alivePlayers = room.players.filter(p => p.isAlive);
    const mafiaFaction = alivePlayers.filter(p => p.role === 'mafia' || p.role === 'chameleon');
    const citizenFaction = alivePlayers.filter(p => p.role !== 'mafia' && p.role !== 'chameleon' && p.role !== 'jester');
    const jesterAlive = alivePlayers.some(p => p.role === 'jester');

    // 1. 마피아 진영이 전멸한 경우 -> 시민 승리
    if (mafiaFaction.length === 0) {
        io.to(room.id).emit('gameOver', { winner: 'citizen' });
        room.status = 'waiting';
        return true;
    }

    // 2. 마피아 진영의 수가 생존한 시민 진영(제스터 제외)의 수보다 같거나 많아진 경우 -> 마피아 승리
    if (mafiaFaction.length >= citizenFaction.length) {
        io.to(room.id).emit('gameOver', { winner: 'mafia' });
        room.status = 'waiting';
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
            // 밤 진행용 임시 데이터 영역
            nightActions: {
                mafiaVotes: {},      // 각 마피아/카멜레온이 투표한 타겟 {쏘는사람ID: 맞은사람ID}
                chameleonTarget: null, // 카멜레온이 찜해둔 신분 교환 대상 유저 ID
                doctorTarget: null,   // 의사가 치료한 유저 ID
                policeTarget: null,   // 경찰이 쏜 유저 ID
                reporterTarget: null, // 기자가 취재한 유저 ID
                reporterSkipped: false
            },
            // 낮 진행용 임시 데이터 영역
            dayVotes: {}, // {투표한사람ID: 지목당한사람ID}
            cooldowns: {}, // 기자 취재 쿨다운 추적
            lastChatTime: {} // 도배방지용 시간 기록
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

    // 5. 채팅 메시지 처리 (마피아 밤 대화 및 도배방지 포함)
    socket.on('sendMessage', ({ roomId, message, username, type }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (type === 'game' && player && !player.isAlive) return; // 사망자 채팅 금지

        // 도배 금지 옵션 체크
        if (room.settings.antiSpam && room.status === 'day') {
            const now = Date.now();
            const lastTime = room.lastChatTime[socket.id] || 0;
            if (now - lastTime < 1000) {
                return socket.emit('errorMessage', '⚠️ 도배 방지: 1초 후에 다시 입력할 수 있습니다.');
            }
            room.lastChatTime[socket.id] = now;
        }

        // 밤에 마피아/카멜레온 전용 비밀 채팅 처리
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

        // 일반 공개 채팅 (대기실 및 낮 토론)
        io.to(roomId).emit('receiveMessage', { username, message, type, isSecret: false });
    });

    // 6. 밤 능력 사용 접수
    // 6-A. 마피아 & 카멜레온의 암살 투표
    socket.on('mafiaAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || (player.role !== 'mafia' && player.role !== 'chameleon')) return;

        room.nightActions.mafiaVotes[socket.id] = targetId;
        checkNightTurnEnd(roomId);
    });

    // 6-B. 카멜레온 전용 신분교환 대상 설정
    socket.on('chameleonAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || player.role !== 'chameleon') return;

        // targetId가 'skip' 이면 교환하지 않음(null)
        room.nightActions.chameleonTarget = targetId === 'skip' ? null : targetId;
        checkNightTurnEnd(roomId);
    });

    // 6-C. 의사의 치료 액션
    socket.on('doctorAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || player.role !== 'doctor') return;

        room.nightActions.doctorTarget = targetId;
        checkNightTurnEnd(roomId);
    });

    // 6-D. 경찰의 사살 액션
    socket.on('policeAction', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'night') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || player.role !== 'police') return;

        room.nightActions.policeTarget = targetId;
        checkNightTurnEnd(roomId);
    });

    // 6-E. 기자의 특종 취재 액션 및 패스
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

    // 밤 상호작용 종료 여부 확인 및 낮 전환 핵심 로직
    function checkNightTurnEnd(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        const alivePlayers = room.players.filter(p => p.isAlive);

        // 각 능력 소지 직업의 생존 여부 파악
        const hasMafiaGroup = alivePlayers.some(p => p.role === 'mafia' || p.role === 'chameleon');
        const hasChameleon = alivePlayers.some(p => p.role === 'chameleon');
        const hasDoctor = alivePlayers.some(p => p.role === 'doctor');
        const hasPolice = alivePlayers.some(p => p.role === 'police');
        const hasReporter = alivePlayers.some(p => p.role === 'reporter');

        // 현재 생존한 직업들이 모두 결정을 내렸는지 대조
        if (hasMafiaGroup) {
            const totalMafiaGroupCount = alivePlayers.filter(p => p.role === 'mafia' || p.role === 'chameleon').length;
            if (Object.keys(room.nightActions.mafiaVotes).length < totalMafiaGroupCount) return;
        }
        // 카멜레온의 신분 교환 의사 체크 (투표를 마쳤으나 신분 교환 데이터가 아직 들어오지 않은 과도기 방지)
        if (hasChameleon && room.nightActions.chameleonTarget === undefined) return;
        if (hasDoctor && !room.nightActions.doctorTarget) return;
        if (hasPolice && !room.nightActions.policeTarget) return;
        if (hasReporter && room.cooldowns[room.players.find(p => p.role === 'reporter' && p.isAlive)?.id] === 0) {
            if (!room.nightActions.reporterTarget && !room.nightActions.reporterSkipped) return;
        }

        // 🌕 모든 조건 충족 시 낮(Day) 연산 시작
        room.status = 'day';
        let logMessages = [];
        let reporterNewsText = "";

        // 1. 마피아 집행 타겟 정산 (다수결 유도 혹은 첫 투표자 기준 병합)
        let finalMafiaKillTargetId = null;
        const votes = Object.values(room.nightActions.mafiaVotes);
        if (votes.length > 0) {
            // 빈도수가 가장 높은 타겟 추출
            const frequency = {};
            votes.forEach(v => frequency[v] = (frequency[v] || 0) + 1);
            finalMafiaKillTargetId = Object.keys(frequency).reduce((a, b) => frequency[a] >= frequency[b] ? a : b);
        }

        // 2. 의사 보호막 연산
        let isSavedByDoctor = false;
        if (finalMafiaKillTargetId && finalMafiaKillTargetId === room.nightActions.doctorTarget) {
            isSavedByDoctor = true;
        }

        // 3. 마피아 암살 실행 결과 기록 및 🦎 카멜레온 신분 교환 가동 여부 결정
        let actualKillSuccess = false;
        if (finalMafiaKillTargetId) {
            const targetPlayer = room.players.find(p => p.id === finalMafiaKillTargetId);
            if (targetPlayer && targetPlayer.isAlive) {
                if (isSavedByDoctor) {
                    logMessages.push(`의사의 눈부신 활약으로 밤사이 아무도 희생되지 않았습니다!`);
                } else {
                    targetPlayer.isAlive = false;
                    logMessages.push(`💀 밤사이 주민 [ ${targetPlayer.username} ] 님이 마피아의 습격을 받아 참혹하게 사망했습니다.`);
                    actualKillSuccess = true; // 암살 최종 성공 판정
                }
            }
        } else {
            logMessages.push(`밤사이 아무 일도 일어나지 않았습니다.`);
        }

        // ★ 카멜레온 강제 신분 복제 로직 연동 ★
        // 암살이 최종 성공했고, 카멜레온이 신분 교환 대상을 건너뛰지(skip) 않고 지정한 경우 실행
        if (actualKillSuccess && hasChameleon && room.nightActions.chameleonTarget) {
            const chameleonPlayer = room.players.find(p => p.role === 'chameleon' && p.isAlive);
            const swapTargetPlayer = room.players.find(p => p.id === room.nightActions.chameleonTarget);

            // 신분 교환 대상이 유효하고 생존해 있는 상태라면 대상을 강제로 바꿉니다.
            if (chameleonPlayer && swapTargetPlayer && swapTargetPlayer.isAlive) {
                const oldChameleonName = chameleonPlayer.username;
                const oldTargetName = swapTargetPlayer.username;

                // 닉네임 문자열 스왑
                chameleonPlayer.username = oldTargetName;
                swapTargetPlayer.username = oldChameleonName;

                logMessages.push(`⚠️ [카멜레온 교란] 카멜레온이 신분을 위조하여 생존자 중 한 명과 이름을 바꾸었습니다!`);
            }
        }

        // 4. 경찰 총격 연산 (마피아 진영 사살 시 처단, 시민 사살 시 아군 오사로 본인 사망)
        if (hasPolice && room.nightActions.policeTarget) {
            const policeTargetPlayer = room.players.find(p => p.id === room.nightActions.policeTarget);
            const policePlayer = room.players.find(p => p.role === 'police' && p.isAlive);

            if (policeTargetPlayer && policeTargetPlayer.isAlive && policePlayer) {
                if (policeTargetPlayer.role === 'mafia' || policeTargetPlayer.role === 'chameleon') {
                    policeTargetPlayer.isAlive = false;
                    logMessages.push(`🚨 [경찰 출동] 경찰의 정밀 사격으로 마피아 진영인 [ ${policeTargetPlayer.username} ]을 처단했습니다!`);
                } else {
                    // 무고한 시민 사살 시 경찰 자책 사망
                    policePlayer.isAlive = false;
                    logMessages.push(`🚨 [경찰 오사] 경찰이 선량한 시민을 저격하는 실책을 범해, 자책감으로 스스로 목숨을 끊었습니다.`);
                }
            }
        }

        // 5. 기자 취재 연산 및 특종 뉴스 발행
        if (hasReporter && room.nightActions.reporterTarget) {
            const reporterPlayer = room.players.find(p => p.role === 'reporter' && p.isAlive);
            const reporterTargetPlayer = room.players.find(p => p.id === room.nightActions.reporterTarget);

            if (reporterPlayer && reporterTargetPlayer) {
                const roleKrs = { mafia: '마피아 🕵️', chameleon: '카멜레온 🦎', doctor: '의사 💉', police: '경찰 🚨', citizen: '시민 🧍', jester: '제스터 🤡', reporter: '기자 📰' };
                reporterNewsText = `📰 [기자 특종 뉴스]\n기자가 목숨을 걸고 취재한 결과, [ ${reporterTargetPlayer.username} ] 님의 본래 신분은 법적으로 [[ ${roleKrs[reporterTargetPlayer.role]} ]] 임이 입증되었습니다!`;
                
                // 취재 완료 시 다음 2턴 동안 취재 불가 쿨다운 설정
                room.cooldowns[reporterPlayer.id] = 3; 
            }
        }

        // 모든 생존자 대상 기자 쿨다운 수치 1씩 차감 적용
        room.players.forEach(p => {
            if (room.cooldowns[p.id] > 0) room.cooldowns[p.id]--;
        });

        // 6. 밤사이 발생한 누적 사망 및 승리 체크 후 낮 브로드캐스팅
        const gameOverTriggered = checkGameOver(room);

        if (!gameOverTriggered) {
            // 낮 투표 데이터 및 마피아 임시 테이블 초기화
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

        // 투표 데이터 적재
        room.dayVotes[socket.id] = targetId;

        // 투표 진행 상황 실시간 공유용 타겟 네임 정의
        let targetName = "투표 건너뛰기 ⏩";
        if (targetId !== 'skip') {
            const target = room.players.find(p => p.id === targetId);
            if (target) targetName = target.username;
        }

        io.to(roomId).emit('voteProgress', { voterName: voter.username, targetName });

        // 생존 중인 유저들이 모두 투표를 끝냈는지 확인
        const alivePlayers = room.players.filter(p => p.isAlive);
        if (Object.keys(room.dayVotes).length === alivePlayers.length) {
            processDayVoteResult(roomId);
        }
    });

    // 낮 처형 다수결 판정 및 밤 전환 로직
    function processDayVoteResult(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        const voteValues = Object.values(room.dayVotes);
        const frequency = {};
        
        // 투표 수 카운팅
        voteValues.forEach(v => frequency[v] = (frequency[v] || 0) + 1);

        // 최고 득표수 식별
        let maxVotes = 0;
        let finalTargetId = null;
        let isTie = false;

        Object.keys(frequency).forEach(id => {
            if (frequency[id] > maxVotes) {
                maxVotes = frequency[id];
                finalTargetId = id;
                isTie = false;
            } else if (frequency[id] === maxVotes) {
                isTie = true; // 동률 발생
            }
        });

        let resultMessage = "";

        // 과반이나 다수결에 따른 최종 처형 결정 단계
        if (isTie || finalTargetId === 'skip' || !finalTargetId) {
            resultMessage = "의견이 분분하거나 투표 스킵 의견이 많아, 낮 시간 동안 아무도 처형되지 않고 밤이 찾아옵니다.";
        } else {
            const executedPlayer = room.players.find(p => p.id === finalTargetId);
            if (executedPlayer && executedPlayer.isAlive) {
                executedPlayer.isAlive = false;
                resultMessage = `⚖️ 주민들의 다수결 투표에 의해 [ ${executedPlayer.username} ] 님이 마피아로 몰려 단두대에서 처형되었습니다.`;

                // 처형당한 유저가 하필 🤡 제스터(바보)인 경우 고유 단독 승리 즉시 발동
                if (executedPlayer.role === 'jester') {
                    io.to(roomId).emit('gameOver', { winner: 'jester', winnerName: executedPlayer.username });
                    room.status = 'waiting';
                    return;
                }
            }
        }

        // 게임 오버 여부 재진단 후 이상 없을 시 다시 밤(Night) 구조로 환원
        const gameOverTriggered = checkGameOver(room);

        if (!gameOverTriggered) {
            room.status = 'night';
            // 밤 턴 구조 완전 리셋
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
                rooms[roomId].players.splice(index, 1); // 배열에서 이탈 유저 제거
            }
        });

        if (targetRoomId) {
            const room = rooms[targetRoomId];
            
            // 방에 사람이 아예 없으면 방 삭제
            if (room.players.length === 0) {
                delete rooms[targetRoomId];
                return;
            }

            // 방장이 나갔다면 방장 권한을 다음 사람에게 자동 위임
            if (room.masterId === socket.id && room.players.length > 0) {
                room.masterId = room.players[0].id;
                room.players[0].isMaster = true;
            }

            // 대기실 상태에서 나갔다면 로비 데이터 최신화
            if (room.status === 'waiting') {
                io.to(targetRoomId).emit('roomData', room);
            } else {
                // 게임 진행 도중 도망친 경우 남은 인원 기준으로 승리 조건 재체크
                io.to(targetRoomId).emit('systemMessage', `유저 한 명이 연결을 해제하여 탈주 처리되었습니다.`);
                const gameOverTriggered = checkGameOver(room);
                if (!gameOverTriggered) {
                    // 아직 진행 중이라면 생존자 명단 업데이트용 트리거 송신
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
