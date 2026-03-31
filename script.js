const PRIMARY_URL = 'https://script.google.com/macros/s/AKfycbzq7ENrYXslbbB6msmCdDDHXEdY9xtMOcL6lclN02S-jGgv1_Cph9q_J14tFH0d4Bcn7A/exec';

async function callGAS(action, params = {}, method = 'GET', body = null) {
    const url = `${PRIMARY_URL}?action=${action}&${new URLSearchParams(params)}`;
    const options = { method };
    if (body && method === 'POST') {
        options.body = body;
        options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    }
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

async function fetchWithFallback(action, params = {}, method = 'GET', body = null) {
    return callGAS(action, params, method, body);
}

let allStudents = [];
let isMakeupMode = false;
let makeupSelectedStudents = new Set();
let makeupDate = '';
let selectedAttendanceStudents = new Set();
let currentUser = null;
const processing = {};

let attendanceCollapsed = {};

let currentNoteTarget = null;
let currentConfirmCallback = null;
let currentPromptCallback = null;
let classCollapsed = {};
let pendingNewStudent = null;
let allClasses = [];
let selectedClasses = new Set();

let selectedPaymentFile = null;
let selectedPaymentStudent = null;
let selectedPaymentClass = null;
let selectedPhotoFile = null;

let pendingApprovals = [];
let trialNotifications = [];
let paymentNotifications = [];
let newStudentNotifications = [];

let notificationCollapsed = false;

function normalizeStudentClasses(students) {
    return students.map(s => {
        if (typeof s.class === 'string') {
            s.class = s.class.split(',').map(c => c.trim()).filter(c => c);
        } else if (!Array.isArray(s.class)) {
            s.class = [];
        }
        return s;
    });
}
function clearBrowserCache() {
    // 清除所有以 attendance_ 開頭的 localStorage 鍵值
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('attendance_')) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    // 可選：清除點名選取狀態
    if (window.selectedAttendanceStudents) window.selectedAttendanceStudents.clear();
    if (window.makeupSelectedStudents) window.makeupSelectedStudents.clear();
    // 重新載入頁面以確保所有狀態重置
    location.reload();
}
function showConfirm(message, callback) {
    const modal = document.getElementById('confirmModal');
    const msgElem = document.getElementById('confirmMessage');
    const confirmBtn = document.getElementById('confirmBtn');
    if (!modal || !msgElem || !confirmBtn) return;
    msgElem.innerText = message;
    modal.style.display = 'flex';
    const handler = function() {
        modal.style.display = 'none';
        confirmBtn.removeEventListener('click', handler);
        if (callback) callback();
    };
    confirmBtn.addEventListener('click', handler);
    modal.onclick = function(e) {
        if (e.target === modal) {
            modal.style.display = 'none';
            confirmBtn.removeEventListener('click', handler);
        }
    };
}

function getDisplayType(reason) {
    const mapping = {
        '點名扣課': '上課',
        '補點名': '補點名',
        '續費': '續費',
        '已續費': '續費',
        '課堂改動': '課堂改動',
        '請假扣課': '請假扣課'
    };
    return mapping[reason] || reason;
}

function showAlert(message) {
    const modal = document.getElementById('alertModal');
    const msgElem = document.getElementById('alertMessage');
    if (!modal || !msgElem) return;
    msgElem.innerText = message;
    modal.style.display = 'flex';
    modal.onclick = function(e) {
        if (e.target === modal) modal.style.display = 'none';
    };
}

function closeAlertModal() {
    const modal = document.getElementById('alertModal');
    if (modal) modal.style.display = 'none';
}

function showPrompt(title, defaultValue, callback) {
    let modal = document.getElementById('promptModal');
    if (!modal) {
        const modalDiv = document.createElement('div');
        modalDiv.id = 'promptModal';
        modalDiv.className = 'modal-overlay';
        modalDiv.innerHTML = `
            <div class="modal-content">
                <h3 id="promptTitle">${title}</h3>
                <input type="text" id="promptInput" value="${defaultValue || ''}" style="width:100%; margin-bottom:20px;">
                <div class="modal-buttons">
                    <button class="cancel" onclick="closePromptModal()">取消</button>
                    <button class="confirm" id="promptConfirmBtn">確定</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalDiv);
        modal = modalDiv;
    }
    const titleElem = document.getElementById('promptTitle');
    const inputElem = document.getElementById('promptInput');
    const confirmBtn = document.getElementById('promptConfirmBtn');
    if (titleElem) titleElem.innerText = title;
    if (inputElem) inputElem.value = defaultValue || '';
    modal.style.display = 'flex';

    const handler = function() {
        modal.style.display = 'none';
        confirmBtn.removeEventListener('click', handler);
        const val = inputElem.value.trim();
        if (callback) callback(val || null);
    };
    confirmBtn.addEventListener('click', handler);
    modal.onclick = function(e) {
        if (e.target === modal) {
            modal.style.display = 'none';
            confirmBtn.removeEventListener('click', handler);
            if (callback) callback(null);
        }
    };
}

function closePromptModal() {
    const modal = document.getElementById('promptModal');
    if (modal) modal.style.display = 'none';
}

async function login() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) return showLoginError('請輸入用戶名與密碼');

    const loginBtn = document.querySelector('#loginForm .btn-primary');
    const originalText = loginBtn.textContent;
    loginBtn.disabled = true;
    loginBtn.textContent = '登入中...';

    try {
        const data = await fetchWithFallback('verifyUser', { username, password });
        if (data.success) {
            const role = (data.role || '').toLowerCase();
            currentUser = {
                username: data.username,
                role: role,
                authorizedClasses: data.authorizedClasses
            };
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            let roleName = '助教';
            if (role === 'admin') roleName = '管理員';
            else if (role === 'coach') roleName = '教練';
            document.getElementById('userInfoDisplay').textContent = `👤 ${data.username} (${roleName})`;
            document.getElementById('loadingSpinner').style.display = 'flex';
            document.getElementById('appContent').style.display = 'none';
            await loadAllData();
        } else {
            showLoginError(data.error || '用戶名或密碼錯誤');
        }
    } catch (e) {
        showLoginError('連線失敗: ' + e.message);
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = originalText;
    }
}

function showLoginError(msg) {
    document.getElementById('loginMessage').innerHTML = `<span class="error">${msg}</span>`;
}

function logout() {
    localStorage.removeItem('currentUser');
    currentUser = null;
    allStudents = [];
    document.getElementById('mainContent').style.display = 'none';
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('loginMessage').innerHTML = '';
    // 不再需要清除 localStorage 中的 attendance 標記
    allStudents.forEach(s => {});
    classCollapsed = {};
    document.getElementById('notificationBody').innerHTML = '';
    document.getElementById('notificationCount').textContent = '0';
}

function scrollToSection(sectionId) {
    setTimeout(() => {
        const element = document.getElementById(sectionId);
        if (element) {
            const rect = element.getBoundingClientRect();
            const absoluteTop = rect.top + window.pageYOffset - 20;
            window.scrollTo({ top: absoluteTop, behavior: 'smooth' });
        }
    }, 350);
}

async function loadAllData() {
    try {
        document.getElementById('loadingSpinner').style.display = 'flex';
        const data = await fetchWithFallback('getInitialData');

        allStudents = normalizeStudentClasses(data.students || []);
        allClasses = data.classes || [];
        pendingApprovals = data.pendingApprovals || [];

        const authClasses = getAuthorizedClasses();
        const isAuthorizedForClass = (className) => {
            if (authClasses === '*') return true;
            if (!className) return false;
            return authClasses.includes(className);
        };

        paymentNotifications = (data.paymentRecords || [])
            .filter(p => !p.processed && isAuthorizedForClass(p.className))
            .map(p => ({
                studentName: p.studentName,
                className: p.className,
                paymentDate: p.paymentDate,
                time: p.time,
                imageUrl: p.imageUrl
            }));

        trialNotifications = (data.trialStudents || [])
            .filter(t => !t.paid || t.date >= getTodayUTC8());

        const paidStudentNames = new Set((data.paymentRecords || []).map(p => p.studentName));
        newStudentNotifications = allStudents
            .filter(s => s.flags === 'new' && !paidStudentNames.has(s.name) && s.class.some(cls => isAuthorizedForClass(cls)))
            .map(s => ({ name: s.name, className: s.class.join(',') }));

        // 關閉 loading，顯示主內容
        document.getElementById('loadingSpinner').style.display = 'none';
        document.getElementById('appContent').style.display = 'block';

        // 立即渲染核心區塊（點名區塊、學生資訊區塊），它們預設摺疊，速度極快
        updateAttendanceList();    // 點名區塊（會根據 isMakeupMode 顯示對應按鈕）
        renderNoteListByClass();   // 學生資訊區塊（預設摺疊）
        updateRentalList();        // 租借區塊（無摺疊，但內容簡單）

        // 延遲渲染通知欄，避免阻塞主線程
        setTimeout(() => {
            renderNotificationBody();
        }, 100);

        applyRoleRestrictions();

    } catch (error) {
        console.error(error);
        document.getElementById('loadingSpinner').innerHTML = `
            <p style="color: #c53030;">載入失敗，請重新整理頁面或聯繫管理員。</p>
            <button class="btn btn-primary" onclick="location.reload()">重新整理</button>
        `;
    }
}

function applyRoleRestrictions() {
    const role = currentUser.role;
    const isAdmin = role === 'admin';
    const isCoach = role === 'coach';
    const isAssistant = role === 'assistant';

    document.getElementById('btnPaymentUpload').style.display = (isAdmin || isCoach) ? 'block' : 'none';
    document.getElementById('btnClassManage').style.display = isAdmin ? 'block' : 'none';
    document.getElementById('btnUserManage').style.display = isAdmin ? 'block' : 'none';
    document.getElementById('btnTrial').style.display = (isAdmin || isCoach) ? 'block' : 'none';
    document.getElementById('btnAddClasses').style.display = (isAdmin || isCoach) ? 'block' : 'none';
    document.getElementById('btnAddStudent').style.display = (isAdmin || isCoach) ? 'block' : 'none';
    document.getElementById('btnCoachLeave').style.display = (isAdmin || isCoach) ? 'block' : 'none';
    document.getElementById('btnClear').style.display = (isAdmin || isCoach) ? 'block' : 'none';
    document.getElementById('btnAttendance').style.display = 'block';
    document.getElementById('btnRental').style.display = 'block';
    document.getElementById('btnPhoto').style.display = 'block';

    document.getElementById('trialAddForm').style.display = isAdmin ? 'flex' : 'none';
}

async function showSection(sectionId) {
    if (!currentUser) return;

    const role = currentUser.role;
    const isAdmin = role === 'admin';
    const isCoach = role === 'coach';
    const isAssistant = role === 'assistant';

    if (!isAdmin && !isCoach) {
        if (sectionId === 'clear') {
            showError('您沒有權限查看學生資訊');
            return;
        }
    }
    if (!isAdmin) {
        if (sectionId === 'userManage' || sectionId === 'classManage') {
            showError('您沒有權限使用此功能');
            return;
        }
    }

    showLoadingSpinner('載入中，請稍後...');

    try {
        const sections = ['attendance','rental','trial','addClasses','addStudent','classManage','clear','coachLeave','userManage'];
        sections.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = id === sectionId ? 'block' : 'none';
        });

        if (sectionId === 'trial') {
            await loadTrialList();
            scrollToSection('trial');
        } else if (sectionId === 'userManage' && isAdmin) {
            selectedClasses.clear();
            renderClassSelection();
            await loadUserList();
            scrollToSection('userManage');
        } else if (sectionId === 'classManage' && isAdmin) {
            await loadClassList();
            scrollToSection('classManage');
        } else if (sectionId === 'clear') {
            renderNoteListByClass();
            scrollToSection('clear');
        } else if (sectionId === 'addClasses') {
            scrollToSection('addClasses');
        } else if (sectionId === 'addStudent') {
            selectedNewStudentClasses.clear();
            renderClassCheckboxes();
            document.getElementById('newStudentName').value = '';
            document.getElementById('newStudentNote').value = '';
            document.getElementById('newStudentClass').value = '';
            scrollToSection('addStudent');
        } else if (sectionId === 'attendance') {
            updateAttendanceList();
            scrollToSection('attendance');
            const attendanceDiv = document.getElementById('attendance');
            let hint = document.getElementById('makeupHint');
            if (!hint) {
                hint = document.createElement('div');
                hint.id = 'makeupHint';
                hint.className = 'info-box';
                hint.style.marginBottom = '15px';
                attendanceDiv.insertBefore(hint, attendanceDiv.firstChild);
            }
            if (isMakeupMode) {
                let actionButtons = '';
                if (isAdmin || isAssistant) {
                    actionButtons = `<button class="btn-sm" onclick="exitMakeupMode()" style="margin-left:10px;">退出</button>`;
                    hint.innerHTML = `📅 目前為 <strong>補點名模式</strong>，日期：${makeupDate}`;
                } else if (isCoach) {
                    actionButtons = `<button class="btn-sm" onclick="exitMakeupMode()" style="margin-left:10px;">退出</button>`;
                    hint.innerHTML = `📅 目前為 <strong>補點名模式</strong>，日期：${makeupDate}<br>點擊學生直接補點名`;
                }
                hint.innerHTML += `<span style="margin-left:10px;">已選 <span id="selectedCount">${makeupSelectedStudents.size}</span> 位學生</span> ${actionButtons}`;
                hint.style.display = 'block';
            } else {
                hint.style.display = 'none';
            }
        } else if (sectionId === 'rental') {
            updateRentalList();
            scrollToSection('rental');
        } else if (sectionId === 'coachLeave') {
            scrollToSection('coachLeave');
        }
    } catch (error) {
        console.error('載入區塊失敗', error);
        showError('載入失敗，請稍後再試');
    } finally {
        hideLoadingSpinner();
    }
}

async function fetchAllStudents() {
    const data = await fetchWithFallback('getAllStudents');
    allStudents = normalizeStudentClasses(data || []);
    return allStudents;
}

function renderClassCheckboxes() {
    const container = document.getElementById('newStudentClassContainer');
    if (!container) return;
    
    const allowed = getAuthorizedClasses();
    let displayClasses = [];
    if (allowed === '*') {
        displayClasses = [...allClasses];
    } else {
        displayClasses = allClasses.filter(c => allowed.includes(c));
    }
    
    let html = '';
    displayClasses.forEach(className => {
        html += `<span class="class-badge" style="cursor:pointer; background:#4299e1;" onclick="toggleNewStudentClass('${className}')">${className}</span>`;
    });
    container.innerHTML = html;
    
    Array.from(container.children).forEach(child => {
        const cls = child.textContent.trim();
        if (selectedNewStudentClasses.has(cls)) {
            child.style.background = '#48bb78';
        } else {
            child.style.background = '#4299e1';
        }
    });
}

let selectedNewStudentClasses = new Set();

function toggleNewStudentClass(className) {
    if (selectedNewStudentClasses.has(className)) {
        selectedNewStudentClasses.delete(className);
    } else {
        selectedNewStudentClasses.add(className);
    }
    const container = document.getElementById('newStudentClassContainer');
    Array.from(container.children).forEach(child => {
        if (child.textContent.trim() === className) {
            child.style.background = selectedNewStudentClasses.has(className) ? '#48bb78' : '#4299e1';
        }
    });
    document.getElementById('newStudentClass').value = Array.from(selectedNewStudentClasses).join(',');
}

function sortClasses(classes) {
    return classes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function loadClassList() {
    let classes = await fetchWithFallback('getAllClasses');
    classes = sortClasses(classes);
    
    if (currentUser && currentUser.role !== 'admin') {
        const allowed = getAuthorizedClasses();
        if (allowed !== '*') {
            classes = classes.filter(c => allowed.includes(c));
        }
    }
    
    allClasses = classes;
    
    renderClassList(classes);
    
    selectedNewStudentClasses.clear();
    renderClassCheckboxes();
    document.getElementById('newStudentClass').value = '';
    
    renderClassSelection();
    
    return classes;
}

function getFilteredStudents() {
    const allowedClasses = getAuthorizedClasses();
    if (allowedClasses === '*') return allStudents;
    return allStudents.filter(s => 
        s.class.some(cls => allowedClasses.includes(cls))
    );
}

function renderClassList(classes) {
    const container = document.getElementById('classListContainer');
    if (!container) return;
    let html = '';
    classes.forEach(c => {
        html += `<span class="class-badge">${c} 
            <button onclick="deleteClass('${c}')" style="background:transparent; border:none; color:white; margin-left:8px; cursor:pointer;">✕</button>
        </span>`;
    });
    container.innerHTML = html || '尚無班級，請新增。';
}

async function addNewClass() {
    if (currentUser.role !== 'admin') { showError('無權限'); return; }
    const className = document.getElementById('newClassName').value.trim();
    if (!className) return showError('請輸入班級名稱');
    const result = await fetchWithFallback('addClass', { className });
    if (result.success) {
        showSuccess(result.message);
        document.getElementById('newClassName').value = '';
        loadClassList();
    } else {
        showError(result.message);
    }
}

async function deleteClass(className) {
    if (currentUser.role !== 'admin') { showError('無權限'); return; }
    showConfirm(`確定刪除班級「${className}」？`, async () => {
        const result = await fetchWithFallback('deleteClass', { className });
        if (result.success) {
            showSuccess(result.message);
            loadClassList();
        } else {
            showError(result.message);
        }
    });
}

async function skipPaymentNotification(studentName, time) {
    const student = allStudents.find(s => s.name === studentName);
    if (!student || student.flags !== 'new') {
        showAlert('只有新增學生方可略過本通知，其他學生請按續費流程，否則可能出現未知錯誤。');
        return;
    }
    showLoadingSpinner('處理中...');
    try {
        const markResult = await fetchWithFallback('markPaymentProcessed', { time, studentName });
        if (!markResult.success) throw new Error(markResult.error || '標記繳費記錄失敗');

        const clearResult = await fetchWithFallback('clearStudentNewFlag', { name: studentName });
        if (!clearResult.success) throw new Error(clearResult.error || '清除新學生標記失敗');

        const studentIndex = allStudents.findIndex(s => s.name === studentName);
        if (studentIndex !== -1) allStudents[studentIndex].flags = '';

        paymentNotifications = paymentNotifications.filter(p => !(p.studentName === studentName && p.time === time));
        renderNotificationBody();
        renderNoteListByClass();
        showSuccess('已略過該繳費通知，並移除新學生標記');
    } catch (err) {
        showError('操作失敗：' + err.message);
    } finally {
        hideLoadingSpinner();
    }
}

async function showStudentRecords(name) {
    showLoadingSpinner('載入學生記錄...');
    try {
        const data = await fetchWithFallback('getStudentDetails', { name });
        if (data.error) throw new Error(data.error);

        renderCoachStudentModal(data);
        document.getElementById('coachStudentRecordModal').style.display = 'flex';
        const modalContent = document.getElementById('coachStudentRecordContent');
        if (modalContent) modalContent.scrollTop = 0;
    } catch (err) {
        showError('無法載入記錄：' + err.message);
    } finally {
        hideLoadingSpinner();
    }
}

function renderCoachStudentModal(d) {
    let leaveBadge = '';
    if (d.leaveCount >= 2) {
        leaveBadge = `<span class="badge red">⚠️ 請假 ${d.leaveCount} 次</span>`;
    } else {
        leaveBadge = `<span class="badge green">請假 ${d.leaveCount} 次</span>`;
    }

    let remainingDisplay = `<span style="font-size:1.5rem; font-weight:700;">${d.remainingClasses}</span>`;
    let remainingWarning = '';
    if (d.remainingClasses <= 0) {
        remainingDisplay = `<span style="font-size:1.5rem; font-weight:700; color:#b91c1c;">${d.remainingClasses} 堂</span>`;
        remainingWarning = `<div class="warning-text">❗ 剩餘課堂數已用完，請聯繫家長繳費。</div>`;
    } else if (d.remainingClasses <= 2) {
        remainingDisplay = `<span style="font-size:1.5rem; font-weight:700; color:#b45309;">${d.remainingClasses} 堂</span>`;
        remainingWarning = `<div class="warning-text">📌 剩餘課堂不多，請提醒家長續費。</div>`;
    }

    let allRecords = [
        ...d.classRecords.map(r => ({ ...r, type: '課堂', displayType: getDisplayType(r.reason) })),
        ...d.leaveRecords.map(r => ({ date: r.date, type: '請假', displayType: '請假' }))
    ];
    allRecords.sort((a, b) => new Date(b.date) - new Date(a.date));

    function getWeekday(dateStr) {
        if (!dateStr) return '';
        const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const normalized = dateStr.replace(/\//g, '-');
        const d = new Date(normalized + 'T00:00:00');
        if (isNaN(d.getTime())) return '';
        return weekdays[d.getDay()];
    }

    let recordsHtml = '';
    if (allRecords.length === 0) {
        recordsHtml = '<p style="color:#718096;">尚無任何上課或請假記錄。</p>';
    } else {
        recordsHtml = `<div style="overflow-x: auto;">
            <table class="record-table">
                <thead>
                    <tr><th>日期</th><th>時間</th><th>類型</th><th>剩餘堂數</th></tr>
                </thead>
                <tbody>`;
        allRecords.slice(0, 50).forEach(rec => {
            const weekday = getWeekday(rec.date);
            const dateWithWeekday = weekday ? `${rec.date} ${weekday}` : rec.date;
            if (rec.type === '課堂') {
                const isMakeup = rec.reason === '補點名';
                const rowClass = isMakeup ? 'makeup-row' : '';
                const typeLabel = rec.displayType;
                recordsHtml += `<tr class="${rowClass}">
                    <td>${dateWithWeekday}</td>
                    <td>${rec.time || ''}</td>
                    <td><span class="badge blue">${typeLabel}</span></td>
                    <td>${rec.remainingClasses}</td>
                </tr>`;
            } else {
                recordsHtml += `<tr>
                    <td>${dateWithWeekday}</td>
                    <td>—</td>
                    <td><span class="badge yellow">請假</span></td>
                    <td>—</td>
                </tr>`;
            }
        });
        recordsHtml += `</tbody></table></div>`;
    }

    const modalContent = document.getElementById('coachStudentRecordContent');
    modalContent.innerHTML = `
        <h2>🧑‍🎓 ${d.name} ${leaveBadge}</h2>
        ${d.leaveCount >= 2 ? `<div class="warning-text">⚠️ 已請假 ${d.leaveCount} 次，下次請假將自動扣減1堂課。</div>` : ''}
        <div class="modal-info-row">
            <span class="modal-info-label">班級</span>
            <span class="modal-info-value">${Array.isArray(d.class) ? d.class.join(', ') : d.class}</span>
        </div>
        <div class="modal-info-row">
            <span class="modal-info-label">剩餘課堂</span>
            <span class="modal-info-value">${remainingDisplay}</span>
        </div>
        ${remainingWarning}
        <div class="modal-info-row">
            <span class="modal-info-label">租借裝備</span>
            <span class="modal-info-value">${d.rentalCount} 次 (每次 $20)</span>
        </div>
        <h3>📋 完整記錄</h3>
        ${recordsHtml}
        <div class="modal-buttons">
            <button onclick="closeCoachStudentModal()">關閉</button>
        </div>
    `;
}

function closeCoachStudentModal() {
    document.getElementById('coachStudentRecordModal').style.display = 'none';
}

let pendingRenewData = { name: '', className: '' };

function openRenewQuantityModal(name, className, remaining, leaveCount, deductedClasses) {
    if (!name || !className) {
        showError('學生資料不完整，無法開啟續費');
        return;
    }
    pendingRenewData = { name, className };
    document.getElementById('renewStudentName').textContent = name;
    document.getElementById('renewStudentClass').textContent = className;
    document.getElementById('renewQuantityInput').value = 10;
    
    const warningDiv = document.getElementById('renewWarning');
    if (remaining < 0) {
        warningDiv.style.display = 'block';
        warningDiv.innerHTML = `
            ⚠️ 目前剩餘課堂數為 <strong>${remaining}</strong> 堂（負數表示已欠課）。<br>
            該學生已請假 <strong>${leaveCount}</strong> 次，其中因請假超過2次已扣除 <strong>${deductedClasses}</strong> 堂課。<br>
            請確認續費數量時一併考慮這些因素。
        `;
    } else {
        warningDiv.style.display = 'none';
        warningDiv.innerHTML = '';
    }
    
    document.getElementById('renewQuantityModal').style.display = 'flex';
}

function closeRenewQuantityModal() {
    document.getElementById('renewQuantityModal').style.display = 'none';
    pendingRenewData = { name: '', className: '' };
}

async function confirmRenewQuantity() {
    const delta = parseInt(document.getElementById('renewQuantityInput').value);
    if (isNaN(delta) || delta <= 0) {
        showError('請輸入有效的正整數');
        return;
    }
    const name = pendingRenewData.name;
    const className = pendingRenewData.className;
    if (!name || !className) {
        showError('學生資料遺失，請重新點擊續費');
        closeRenewQuantityModal();
        return;
    }
    closeRenewQuantityModal();
    await executeRenew(name, className, delta);
}

async function executeRenew(name, className, delta) {
    if (!name) {
        showError('學生姓名不存在，無法續費');
        return;
    }
    const lockKey = `renew_${name}`;
    if (processing[lockKey]) {
        showError('正在處理中，請稍後...');
        return;
    }
    processing[lockKey] = true;
    showLoadingSpinner('續費處理中...');

    try {
        await fetchAllStudents();
        const student = allStudents.find(s => 
            s.name === name || 
            s.name.trim() === name.trim() || 
            s.name.toLowerCase() === name.toLowerCase()
        );
        if (!student) {
            throw new Error(`找不到學生「${name}」，請確認學生是否存在`);
        }
        const actualClass = student.class.join(',');
        if (actualClass !== className) {
            console.warn(`班級不一致：傳入班級 ${className}，實際班級 ${actualClass}，將使用實際班級`);
            className = actualClass;
        }

        let result = await fetchWithFallback('clearLeaveCount', { name, operator: currentUser.username });
        if (!result.success) throw new Error(result.error || '清零請假失敗');

        result = await fetchWithFallback('clearRental', { name, operator: currentUser.username });
        if (!result.success) throw new Error(result.error || '清零租借失敗');

        const payload = { name, class: className, classesChange: delta, reason: '已續費' };
        result = await fetchWithFallback('addClasses', { data: JSON.stringify(payload), operator: currentUser.username });
        if (!result.success) {
            throw new Error(result.message || '增加課堂失敗');
        }

        const pendingForStudent = paymentNotifications.filter(p => p.studentName === name);
        for (let p of pendingForStudent) {
            if (!p.time || !p.studentName) continue;
            try {
                const markResult = await fetchWithFallback('markPaymentProcessed', { time: p.time, studentName: p.studentName });
                if (!markResult.success) {
                    console.error('標記繳費記錄失敗', markResult);
                    showError(`標記失敗：${markResult.error || '未知錯誤'}`);
                }
            } catch (err) {
                console.error('標記請求錯誤', err);
            }
            paymentNotifications = paymentNotifications.filter(item => !(item.time === p.time && item.studentName === p.studentName));
        }
        renderNotificationBody();

        showSuccess(`${name} 續費成功！已增加 ${delta} 堂課，請假/租借次數歸零。`);

        await fetchAllStudents();
        await loadPaymentNotifications();
        renderNoteListByClass();
        updateRentalList();
    } catch (err) {
        showError(err.message);
        console.error('續費錯誤:', err);
    } finally {
        hideLoadingSpinner();
        delete processing[lockKey];
    }
}

async function quickRenew(name, classNameFromNotification) {
    if (currentUser.role !== 'admin') {
        showError('只有管理員可以執行續費操作');
        return;
    }
    
    await fetchAllStudents();
    const student = allStudents.find(s => 
        s.name === name || 
        s.name.trim() === name.trim() || 
        s.name.toLowerCase() === name.toLowerCase()
    );
    
    if (!student) {
        showConfirm(`找不到學生「${name}」，是否仍使用繳費記錄中的班級「${classNameFromNotification}」進行續費？\n注意：如果學生已改名或轉班，可能導致錯誤。`, () => {
            openRenewQuantityModal(name, classNameFromNotification, 0, 0, 0);
        });
        return;
    }
    
    const currentClass = student.class.join(',');
    const leaveCount = student.leaveCount;
    const deductedClasses = Math.floor(leaveCount / 2);
    const remaining = student.remainingClasses;
    
    if (classNameFromNotification && classNameFromNotification !== currentClass) {
        showConfirm(`此學生目前的班級為「${currentClass}」，但繳費記錄中的班級是「${classNameFromNotification}」。\n是否仍要使用目前班級「${currentClass}」進行續費？`, () => {
            openRenewQuantityModal(student.name, currentClass, remaining, leaveCount, deductedClasses);
        });
    } else {
        openRenewQuantityModal(student.name, currentClass, remaining, leaveCount, deductedClasses);
    }
}

let pendingAddStudentData = { name: '', classStr: '', note: '' };

function openAddStudentQuantityModal(name, classStr, note) {
    if (!name || !classStr) {
        showError('學生資料不完整，無法新增');
        return;
    }
    pendingAddStudentData = { name, classStr, note };
    document.getElementById('addStudentNameDisplay').textContent = name;
    document.getElementById('addStudentClassDisplay').textContent = classStr;
    document.getElementById('addStudentQuantityInput').value = 10;
    document.getElementById('addStudentQuantityModal').style.display = 'flex';
}

function closeAddStudentQuantityModal() {
    document.getElementById('addStudentQuantityModal').style.display = 'none';
    pendingAddStudentData = { name: '', classStr: '', note: '' };
}

async function confirmAddStudentQuantity() {
    const classes = parseInt(document.getElementById('addStudentQuantityInput').value);
    if (isNaN(classes) || classes < 0) {
        showError('請輸入有效的非負整數');
        return;
    }
    const name = pendingAddStudentData.name;
    const classStr = pendingAddStudentData.classStr;
    const note = pendingAddStudentData.note;
    if (!name || !classStr) {
        showError('學生資料遺失，請重新填寫');
        closeAddStudentQuantityModal();
        return;
    }
    closeAddStudentQuantityModal();
    await executeAddStudent(name, classStr, note, classes);
}

async function executeAddStudent(name, classStr, note, classes) {
    name = name.trim();
    if (!name) {
        showError('姓名不能為空');
        return;
    }

    const btn = document.querySelector('#addStudent .btn-indigo');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '提交中...';
    }
    const lockKey = 'addStudent';
    if (processing[lockKey]) {
        showError('正在新增中...');
        return;
    }
    processing[lockKey] = true;

    try {
        const payload = { name, class: classStr, classes: classes, note };
        console.log('新增學生 payload:', JSON.stringify(payload));

        if (currentUser.role === 'admin') {
            const result = await fetchWithFallback('addStudent', { data: JSON.stringify(payload), operator: currentUser.username });
            console.log('addStudent 回應:', result);
            if (result.success) {
                showSuccess(`學生 ${name} 新增成功！已獲得 ${classes} 堂課。`);
                newStudentNotifications.push({ name: name, time: new Date().toISOString() });
                renderNotificationBody();
                document.getElementById('newStudentName').value = '';
                selectedNewStudentClasses.clear();
                renderClassCheckboxes();
                document.getElementById('newStudentNote').value = '';
                await fetchAllStudents();
                updateAttendanceList();
                updateRentalList();
                renderNoteListByClass();
            } else {
                showError(result.message || '新增失敗');
            }
        } else {
            const result = await fetchWithFallback('submitApprovalRequest', { data: JSON.stringify({ type: 'addStudent', payload }), requester: currentUser.username });
            console.log('submitApprovalRequest 回應:', result);
            if (result.success) {
                showSuccess('請求已提交，等待管理員審批');
                document.getElementById('newStudentName').value = '';
                selectedNewStudentClasses.clear();
                renderClassCheckboxes();
                document.getElementById('newStudentNote').value = '';
            } else {
                showError(result.error);
            }
        }
    } catch (err) {
        showError('網路錯誤');
        console.error('executeAddStudent 錯誤:', err);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '提交審批';
        }
        delete processing[lockKey];
    }
}

async function submitAddStudent() {
    if (currentUser.role !== 'admin' && currentUser.role !== 'coach') {
        showError('無權限');
        return;
    }

    const name = document.getElementById('newStudentName').value.trim();
    const classStr = document.getElementById('newStudentClass').value;
    const note = document.getElementById('newStudentNote').value.trim();
    if (!name || !classStr) {
        showError('請填寫姓名與班級');
        return;
    }

    openAddStudentQuantityModal(name, classStr, note);
}

function openEditStudentNameModal(oldName) {
    document.getElementById('oldStudentName').textContent = oldName;
    document.getElementById('newStudentNameInput').value = oldName;
    document.getElementById('editStudentNameModal').style.display = 'flex';
    window.currentEditingStudent = oldName;
}

let editClassStudentName = '';
let editClassSelected = new Set();

function openEditClassModal(studentName, currentClassesStr) {
    editClassStudentName = studentName;
    document.getElementById('editClassStudentName').textContent = studentName;
    
    const currentClasses = currentClassesStr ? currentClassesStr.split(',') : [];
    editClassSelected.clear();
    currentClasses.forEach(c => editClassSelected.add(c.trim()));
    
    renderEditClassButtons();
    document.getElementById('editStudentClassModal').style.display = 'flex';
}

function renderEditClassButtons() {
    const container = document.getElementById('editClassContainer');
    if (!container) return;
    
    const allowed = getAuthorizedClasses();
    let displayClasses = [];
    if (allowed === '*') {
        displayClasses = [...allClasses];
    } else {
        displayClasses = allClasses.filter(c => allowed.includes(c));
    }
    
    let html = '';
    displayClasses.forEach(className => {
        const isSelected = editClassSelected.has(className);
        html += `<span class="class-badge" style="cursor:pointer; background:${isSelected ? '#48bb78' : '#4299e1'};" onclick="toggleEditClass('${className}')">${className} ${isSelected ? '✓' : ''}</span>`;
    });
    container.innerHTML = html;
    document.getElementById('editClassValue').value = Array.from(editClassSelected).join(',');
}

function toggleEditClass(className) {
    if (editClassSelected.has(className)) {
        editClassSelected.delete(className);
    } else {
        editClassSelected.add(className);
    }
    renderEditClassButtons();
}

function closeEditClassModal() {
    document.getElementById('editStudentClassModal').style.display = 'none';
}

async function confirmEditClass() {
    const newClassStr = document.getElementById('editClassValue').value;
    if (!newClassStr) {
        showError('請至少選擇一個班級');
        return;
    }
    const studentName = editClassStudentName;
    closeEditClassModal();
    showLoadingSpinner('更新班級中...');
    try {
        const result = await fetchWithFallback('updateStudentClasses', { name: studentName, classes: newClassStr, operator: currentUser.username });
        if (result.success) {
            showSuccess(`學生 ${studentName} 班級已更新`);
            await fetchAllStudents();
            renderNoteListByClass();
            updateAttendanceList();
            updateRentalList();
        } else {
            showError(result.error || '更新失敗');
        }
    } catch (err) {
        showError('網路錯誤：' + err.message);
    } finally {
        hideLoadingSpinner();
        editClassStudentName = '';
        editClassSelected.clear();
    }
}

function closeEditStudentNameModal() {
    document.getElementById('editStudentNameModal').style.display = 'none';
    window.currentEditingStudent = null;
}

async function submitEditStudentName() {
    const oldName = window.currentEditingStudent;
    const newName = document.getElementById('newStudentNameInput').value.trim();
    if (!newName) {
        showError('請輸入新姓名');
        return;
    }
    if (oldName === newName) {
        showError('新姓名與原姓名相同');
        return;
    }

    showLoadingSpinner('修改姓名中...');
    try {
        const result = await fetchWithFallback('updateStudentName', { oldName, newName, operator: currentUser.username });
        if (result.success) {
            showSuccess('學生姓名修改成功');
            closeEditStudentNameModal();
            await fetchAllStudents();
            renderNoteListByClass();
        } else {
            showError(result.error || '修改失敗');
        }
    } catch (err) {
        showError('網路錯誤：' + err.message);
    } finally {
        hideLoadingSpinner();
    }
}

// ========== 點名相關（修改重點） ==========
function toggleAttendanceStudent(name) {
    if (selectedAttendanceStudents.has(name)) {
        selectedAttendanceStudents.delete(name);
    } else {
        selectedAttendanceStudents.add(name);
    }
    updateAttendanceList();
}

function toggleMakeupStudent(name) {
    if (makeupSelectedStudents.has(name)) {
        makeupSelectedStudents.delete(name);
    } else {
        makeupSelectedStudents.add(name);
    }
    updateAttendanceList();
    const selectedCountSpan = document.getElementById('selectedCount');
    if (selectedCountSpan) {
        selectedCountSpan.textContent = makeupSelectedStudents.size;
    }
}

// 點名區塊各班級收合狀態（與學生資訊區塊的 classCollapsed 分開）

function updateAttendanceList() {
    const container = document.getElementById('attendanceList');
    if (!container) return;

    const filteredStudents = getFilteredStudents();
    const grouped = {};
    filteredStudents.forEach(s => {
        (s.class || []).forEach(className => {
            if (!grouped[className]) grouped[className] = [];
            grouped[className].push(s);
        });
    });

    const fragment = document.createDocumentFragment();
    const sortedClasses = sortClasses(Object.keys(grouped));

    sortedClasses.forEach(className => {
        // 初始化狀態：預設收合
        if (attendanceCollapsed[className] === undefined) {
            attendanceCollapsed[className] = true;
        }
        const isCollapsed = attendanceCollapsed[className];
        const icon = isCollapsed ? '▶' : '▼';

        // 建立班級標題
        const header = document.createElement('div');
        header.className = 'class-header';
        header.setAttribute('data-class', className);
        header.innerHTML = `<span class="toggle-icon">${icon}</span><h3>${className}班</h3>`;
        header.style.cursor = 'pointer';
        header.onclick = (e) => {
            e.stopPropagation();
            // 切換狀態並重新渲染
            attendanceCollapsed[className] = !attendanceCollapsed[className];
            updateAttendanceList();
        };
        fragment.appendChild(header);

        // 建立學生容器
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'class-students';
        bodyDiv.style.display = isCollapsed ? 'none' : 'flex';
        bodyDiv.style.flexWrap = 'wrap';
        bodyDiv.style.gap = '8px';
        bodyDiv.style.marginBottom = '16px';

        grouped[className].forEach(s => {
            const btn = document.createElement('button');
            btn.className = 'student-button';
            if (s.remainingClasses <= 0) btn.classList.add('zero-class');
            if (isMakeupMode && makeupSelectedStudents.has(s.name)) btn.classList.add('selected');
            if (!isMakeupMode && selectedAttendanceStudents.has(s.name)) btn.classList.add('selected');
            btn.setAttribute('data-name', s.name);
            let text = s.name;
            if (currentUser.role !== 'assistant') {
                text += ` <span class="class-count">${s.remainingClasses}堂</span>`;
            }
            btn.innerHTML = text;
            bodyDiv.appendChild(btn);
        });
        fragment.appendChild(bodyDiv);
    });

    container.innerHTML = '';
    container.appendChild(fragment);

    // 控制確認按鈕顯示（維持原有邏輯）
    const btnReview = document.getElementById('btnReviewAttendance');
    const countSpan = document.getElementById('attendanceSelectedCount');
    if (btnReview) {
        if (isMakeupMode) {
            if (makeupSelectedStudents.size > 0) {
                btnReview.style.display = 'block';
                if (countSpan) countSpan.textContent = makeupSelectedStudents.size;
                btnReview.onclick = () => openMakeupApprovalModal();
                btnReview.textContent = `📝 確認點名 (${makeupSelectedStudents.size}人)`;
            } else {
                btnReview.style.display = 'none';
            }
        } else {
            if (selectedAttendanceStudents.size > 0) {
                btnReview.style.display = 'block';
                if (countSpan) countSpan.textContent = selectedAttendanceStudents.size;
                btnReview.onclick = () => openBatchAttendanceModal();
                btnReview.textContent = `📝 確認點名 (${selectedAttendanceStudents.size}人)`;
            } else {
                btnReview.style.display = 'none';
            }
        }
    }
}

function openBatchAttendanceModal() {
    if (processing['batchAttendance']) {
        showError('正在處理點名，請稍後...');
        return;
    }
    if (selectedAttendanceStudents.size === 0) {
        showError("請先選取要點名的學生");
        return;
    }

    const modal = document.getElementById('batchAttendanceModal');
    const listContainer = document.getElementById('batchAttendanceList');
    if (!modal || !listContainer) {
        if (confirm(`確定要為這 ${selectedAttendanceStudents.size} 位學生點名嗎？`)) {
            confirmBatchAttendance();
        }
        return;
    }

    let html = '<table class="record-table" style="width:100%; border-collapse: collapse; margin-top:10px;">';
    if (currentUser.role === 'assistant') {
        // 助教不顯示剩餘堂數
        html += '<thead style="background:#f1f5f9;"><tr><th style="padding:8px; border:1px solid #e2e8f0;">學生姓名</th></tr></thead><tbody>';
        selectedAttendanceStudents.forEach(name => {
            html += `<tr><td style="padding:8px; border:1px solid #e2e8f0; text-align:center;">${name}</td></tr>`;
        });
    } else {
        // 管理員/教練顯示剩餘堂數
        html += '<thead style="background:#f1f5f9;"><tr><th style="padding:8px; border:1px solid #e2e8f0;">學生姓名</th><th style="padding:8px; border:1px solid #e2e8f0;">剩餘堂數</th></tr></thead><tbody>';
        selectedAttendanceStudents.forEach(name => {
            const s = allStudents.find(st => st.name === name);
            const remaining = s ? s.remainingClasses : '-';
            html += `<tr><td style="padding:8px; border:1px solid #e2e8f0; text-align:center;">${name}</td><td style="padding:8px; border:1px solid #e2e8f0; text-align:center;">${remaining} 堂</td></tr>`;
        });
    }
    html += '</tbody></table>';

    listContainer.innerHTML = html;
    modal.style.display = 'flex';
}

function closeBatchAttendanceModal() {
    document.getElementById('batchAttendanceModal').style.display = 'none';
}

async function confirmBatchAttendance() {
    const lockKey = 'batchAttendance';
    if (processing[lockKey]) {
        showError('正在處理中，請勿重複點擊');
        return;
    }
    
    const studentsArray = Array.from(selectedAttendanceStudents);
    if (studentsArray.length === 0) {
        showError('沒有選取任何學生');
        return;
    }
    
    // 清空選中，防止重複提交
    selectedAttendanceStudents.clear();
    
    processing[lockKey] = true;
    closeBatchAttendanceModal();
    showLoadingSpinner('正在處理點名，請勿關閉或重新整理...');
    
    try {
        if (currentUser.role === 'assistant') {
            // 助教：提交審批
            const payload = {
                type: 'attendance',
                payload: {
                    students: studentsArray,
                    date: getTodayUTC8()
                }
            };
            const result = await fetchWithFallback('submitApprovalRequest', { data: JSON.stringify(payload), requester: currentUser.username });
            if (result.success) {
                showSuccess('點名審批請求已提交，等待管理員批准');
                // 清除選中，無需額外操作
            } else {
                showError(result.error || '提交失敗');
                // 失敗時恢復選中
                studentsArray.forEach(name => selectedAttendanceStudents.add(name));
            }
        } else {
            // 管理員/教練：直接扣課
            const formData = new URLSearchParams();
            formData.append('students', JSON.stringify(studentsArray));
            formData.append('operator', currentUser.username);
            const result = await fetchWithFallback('batchMarkAttendance', {}, 'POST', formData);
            if (result && result.success) {
                showSuccess(result.message || '點名成功');
                await loadAllData(); // 重新載入資料以更新剩餘堂數
            } else {
                showError(result ? result.message : '伺服器回應失敗');
                // 失敗時恢復選中
                studentsArray.forEach(name => selectedAttendanceStudents.add(name));
            }
        }
        updateAttendanceList();
    } catch (err) {
        console.error('點名錯誤:', err);
        showError('系統錯誤，請稍後再試');
        studentsArray.forEach(name => selectedAttendanceStudents.add(name));
        updateAttendanceList();
    } finally {
        delete processing[lockKey];
        hideLoadingSpinner();
    }
}

// 補點名確認對話框
function openMakeupApprovalModal() {
    if (makeupSelectedStudents.size === 0) {
        showError("請先選取要補點名的學生");
        return;
    }
    const modal = document.getElementById('makeupApprovalModal');
    const listContainer = document.getElementById('makeupApprovalList');
    if (!modal || !listContainer) {
        if (confirm(`確定要為這 ${makeupSelectedStudents.size} 位學生提交補點名嗎？`)) {
            confirmMakeupApproval();
        }
        return;
    }

    let html = '<table class="record-table" style="width:100%; border-collapse: collapse; margin-top:10px;">';
    if (currentUser.role === 'assistant') {
        // 助教不顯示剩餘堂數
        html += '<thead style="background:#f1f5f9;"><tr><th style="padding:8px; border:1px solid #e2e8f0;">學生姓名</th><th style="padding:8px; border:1px solid #e2e8f0;">班級</th></tr></thead><tbody>';
        makeupSelectedStudents.forEach(name => {
            const s = allStudents.find(st => st.name === name);
            const className = s ? s.class.join(',') : '';
            html += `<tr><td style="padding:8px; border:1px solid #e2e8f0;">${name}</td><td style="padding:8px; border:1px solid #e2e8f0;">${className}</td></tr>`;
        });
    } else {
        // 管理員/教練顯示剩餘堂數
        html += '<thead style="background:#f1f5f9;"><tr><th style="padding:8px; border:1px solid #e2e8f0;">學生姓名</th><th style="padding:8px; border:1px solid #e2e8f0;">班級</th><th style="padding:8px; border:1px solid #e2e8f0;">剩餘堂數</th></tr></thead><tbody>';
        makeupSelectedStudents.forEach(name => {
            const s = allStudents.find(st => st.name === name);
            if (s) {
                html += `<tr><td style="padding:8px; border:1px solid #e2e8f0;">${s.name}</td>`;
                html += `<td style="padding:8px; border:1px solid #e2e8f0;">${s.class.join(',')}</td>`;
                html += `<td style="padding:8px; border:1px solid #e2e8f0;">${s.remainingClasses} 堂</td></tr>`;
            }
        });
    }
    html += '</tbody></table>';

    listContainer.innerHTML = html;
    modal.style.display = 'flex';
}

function closeMakeupApprovalModal() {
    const modal = document.getElementById('makeupApprovalModal');
    if (modal) modal.style.display = 'none';
}

async function confirmMakeupApproval() {
    const lockKey = 'makeupApproval';
    if (processing[lockKey]) {
        showError('正在提交中，請稍後...');
        return;
    }
    processing[lockKey] = true;

    const students = Array.from(makeupSelectedStudents);
    const date = makeupDate;
    if (!date) {
        showError('日期不存在，請重新進入補點名模式');
        processing[lockKey] = false;
        return;
    }

    try {
        if (currentUser.role === 'assistant') {
            // 助教：提交審批
            const payload = {
                type: 'makeupAttendance',
                payload: {
                    students: students,
                    date: date
                }
            };
            const result = await fetchWithFallback('submitApprovalRequest', { data: JSON.stringify(payload), requester: currentUser.username });
            if (result.success) {
                showSuccess('補點名審批請求已提交，等待管理員批准');
                await loadPendingApprovals();
                makeupSelectedStudents.clear();
                exitMakeupMode();
            } else {
                showError(result.error || '提交失敗');
            }
        } else {
            // 管理員/教練：直接批量補點名（循環調用單學生接口）
            showLoadingSpinner('正在補點名，請稍後...');
            let successCount = 0;
            let failList = [];
            for (const name of students) {
                try {
                    const data = await fetchWithFallback('markAttendanceMakeup', { name, operator: currentUser.username, date });
                    if (data.success) {
                        successCount++;
                    } else {
                        failList.push(name);
                    }
                } catch (err) {
                    failList.push(name);
                }
            }
            if (failList.length === 0) {
                showSuccess(`補點名成功！共 ${successCount} 位學生完成補點名。`);
            } else {
                showError(`部分失敗：成功 ${successCount} 位，失敗：${failList.join('、')}`);
            }
            await loadAllData();
            makeupSelectedStudents.clear();
            exitMakeupMode();
        }
    } catch (err) {
        showError('操作失敗：' + err.message);
    } finally {
        delete processing[lockKey];
        hideLoadingSpinner();
        closeMakeupApprovalModal();
    }
}

function exitMakeupMode() {
    isMakeupMode = false;
    makeupDate = '';
    makeupSelectedStudents.clear();
    showSection('attendance');
}

function openMakeupDateModal() {
    const today = getTodayUTC8();
    document.getElementById('makeupDateInput').value = today;
    document.getElementById('makeupDateModal').style.display = 'flex';
}

function closeMakeupDateModal() {
    document.getElementById('makeupDateModal').style.display = 'none';
}

function confirmMakeupDate() {
    const date = document.getElementById('makeupDateInput').value;
    if (!date) {
        showError('請選擇日期');
        return;
    }
    closeMakeupDateModal();

    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const d = new Date(date + 'T00:00:00');
    const weekday = weekdays[d.getDay()];
    const confirmMsg = `你確定要補點名日期 ${date} (${weekday}) 的點名嗎？`;

    showConfirm(confirmMsg, () => {
        isMakeupMode = true;
        makeupDate = date;
        showSection('attendance');
    });
}
// ========== 點名相關結束 ==========

function updateRentalList() {
    const container = document.getElementById('rentalList');
    if (!container) return;

    const filteredStudents = getFilteredStudents();
    const grouped = {};
    filteredStudents.forEach(s => {
        (s.class || []).forEach(className => {
            if (!grouped[className]) grouped[className] = [];
            grouped[className].push(s);
        });
    });

    let html = '';
    for (let className in grouped) {
        html += `<div style="margin-bottom:16px;"><h3>${className}班</h3>`;
        grouped[className].forEach(s => {
            html += `<button class="rental-button" data-name="${s.name}" onclick="addRental('${s.name}')">${s.name} (${s.rentalCount}次)</button>`;
        });
        html += '</div>';
    }
    container.innerHTML = html;
}

async function addRental(name) {
    if (processing[`rental_${name}`]) {
        showError('正在處理中，請稍後...');
        return;
    }
    const btn = document.querySelector(`.rental-button[data-name="${name}"]`);
    if (btn) {
        btn.disabled = true;
        btn.textContent = `${name} (處理中)`;
    }
    processing[`rental_${name}`] = true;

    try {
        const data = await fetchWithFallback('addRental', { name, operator: currentUser.username });
        if (data.success) {
            showSuccess(`${name} 租借+1，總次數 ${data.rentals}`);
            await fetchAllStudents();
            updateRentalList();
            renderNoteListByClass();
        } else {
            showError(data.error || '租借失敗');
            if (btn) {
                btn.disabled = false;
                btn.textContent = `${name} (${allStudents.find(s => s.name === name)?.rentalCount || 0}次)`;
            }
        }
    } catch (err) {
        showError('網路錯誤');
        if (btn) {
            btn.disabled = false;
            btn.textContent = `${name} (${allStudents.find(s => s.name === name)?.rentalCount || 0}次)`;
        }
    } finally {
        delete processing[`rental_${name}`];
    }
}

function getAuthorizedClasses() {
    if (!currentUser) return [];
    if (currentUser.authorizedClasses === '*') return '*';
    return currentUser.authorizedClasses || [];
}

function getTodayUTC8() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function loadTrialNotifications() {
    const trials = await fetchWithFallback('getTrialStudents');
    const today = getTodayUTC8();
    trialNotifications = trials.filter(t => {
        if (!t.paid) return true;
        else return t.date >= today;
    });
    renderNotificationBody();
}

async function loadPaymentNotifications() {
    const payments = await fetchWithFallback('getPaymentRecords');

    const authClasses = getAuthorizedClasses();
    const isAuthorizedForClass = (className) => {
        if (authClasses === '*') return true;
        if (!className) return false;
        return authClasses.includes(className);
    };

    paymentNotifications = payments
        .filter(p => !p.processed && isAuthorizedForClass(p.className))
        .map(p => ({
            studentName: p.studentName,
            className: p.className,
            paymentDate: p.paymentDate,
            time: p.time,
            imageUrl: p.imageUrl
        }));

    const paidStudentNames = new Set(payments.map(p => p.studentName));
    newStudentNotifications = allStudents
        .filter(s => s.flags === 'new' && !paidStudentNames.has(s.name) && s.class.some(cls => isAuthorizedForClass(cls)))
        .map(s => ({ name: s.name, className: s.class.join(',') }));

    renderNotificationBody();
}

async function loadPendingApprovals() {
    const data = await fetchWithFallback('getPendingApprovals');
    pendingApprovals = data;
    renderNotificationBody();
}

function updateNotificationScrollHint() {
    const body = document.getElementById('notificationBody');
    const hint = document.getElementById('notificationScrollHint');
    if (!body || !hint) return;
    if (notificationCollapsed) {
        hint.style.display = 'none';
        return;
    }
    if (body.scrollHeight > body.clientHeight) {
        hint.style.display = 'flex';
    } else {
        hint.style.display = 'none';
    }
}

function scrollNotificationToBottom() {
    const body = document.getElementById('notificationBody');
    if (body) {
        body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
    }
}

function toggleNotificationBody() {
    notificationCollapsed = !notificationCollapsed;
    const body = document.getElementById('notificationBody');
    const header = document.getElementById('notificationHeader');
    if (notificationCollapsed) {
        body.classList.add('collapsed');
        header.classList.add('collapsed');
    } else {
        body.classList.remove('collapsed');
        header.classList.remove('collapsed');
    }
    updateNotificationScrollHint();
}

function renderNotificationBody() {
    const body = document.getElementById('notificationBody');
    const countSpan = document.getElementById('notificationCount');
    if (!body) return;

    let total = 0;
    let html = '';

    trialNotifications.forEach(t => {
        total++;
        html += `<div class="notification-item">
            <span class="type-tag">試堂</span>
            <div class="content">
                <strong>${t.name}</strong> - ${t.date} ${t.rentEquipment ? '🛞' : ''} ${t.paid ? '✅已付' : '❌未付'}
                ${t.note ? `<br><span style="font-size:0.8rem; color:#666;">📝 ${t.note}</span>` : ''}
            </div>
            <div class="actions">`;
        if (currentUser.role === 'admin') {
            if (!t.paid) {
                html += `<button class="btn-sm" onclick="markTrialPaid('${t.name}', '${t.date}')">💰標記已付</button>`;
            }
            html += `<button class="btn-sm" onclick="editTrialDate('${t.name}', '${t.date}')">📅改期</button>`;
        }
        html += `</div></div>`;
    });

    if (currentUser.role === 'admin' || currentUser.role === 'coach') {
        paymentNotifications.forEach(p => {
            total++;
            html += `<div class="notification-item">
                <span class="type-tag">待續費</span>
                <div class="content">${p.studentName} 已上傳繳費憑證，請管理員點擊續費</div>
                <div class="actions">`;
            if (currentUser.role === 'admin') {
                html += `<button class="btn-sm" onclick="quickRenew('${p.studentName}', '${p.className}')">💰續費按此</button>`;
                const student = allStudents.find(s => s.name === p.studentName);
                if (student && student.flags === 'new') {
                    html += `<button class="btn-sm" onclick="skipPaymentNotification('${p.studentName}', '${p.time}')">🚫略過</button>`;
                }
            } else {
                html += `<span style="color:#718096;">等待管理員處理</span>`;
            }
            html += `</div></div>`;
        });
    }

    if (currentUser.role === 'admin') {
        newStudentNotifications.forEach(n => {
            total++;
            html += `<div class="notification-item">
                <span class="type-tag">新學生</span>
                <div class="content">${n.name} 尚未上傳繳費憑證</div>
                <div class="actions">
                   <button class="btn-sm" onclick="uploadPaymentForNewStudent('${n.name}', '${n.className}')">💰上傳繳費</button>
                </div>
            </div>`;
        });
    }

    if (currentUser.role === 'admin') {
        pendingApprovals.forEach(req => {
            total++;
            let content = '';
            if (req.type === 'addClasses') {
                content = `${req.requester} 請求為 ${req.data.name} 增減課堂 (${req.data.classesChange}堂)`;
            } else if (req.type === 'addStudent') {
                content = `${req.requester} 請求新增學生 ${req.data.name}`;
            } else if (req.type === 'deleteStudent') {
                content = `${req.requester} 請求刪除學生 ${req.data.name}`;
            } else if (req.type === 'makeupAttendance') {
                const studentList = req.data.students.join('、');
                content = `${req.requester} 請求為 ${studentList} 補點名 (日期：${req.data.date})`;
            } else if (req.type === 'attendance') {
                const studentList = req.data.students.join('、');
                content = `${req.requester} 請求為 ${studentList} 點名 (日期：${req.data.date})`;
            }
            html += `<div class="notification-item">
                <span class="type-tag">審批</span>
                <div class="content">${content}</div>
                <div class="actions">
                    <button class="btn-sm" onclick="approveRequest('${req.id}')">✅批准</button>
                    <button class="btn-sm" onclick="rejectRequest('${req.id}')">❌拒絕</button>
                </div>
            </div>`;
        });
    } else if (currentUser.role === 'coach') {
        const coachRequests = pendingApprovals.filter(req => {
            return req.type === 'makeupAttendance' || req.requester === currentUser.username;
        });
        coachRequests.forEach(req => {
            let content = '';
            let actions = '';
            let shouldDisplay = true;
            if (req.type === 'makeupAttendance') {
                const studentList = req.data.students.join('、');
                if (req.requester === currentUser.username) {
                    content = `您請求為 ${studentList} 補點名 (日期：${req.data.date}) - 審批中`;
                    actions = `<span style="color:#718096;">等待管理員審批</span>`;
                } else {
                    const authClasses = currentUser.authorizedClasses;
                    const authorizedStudents = [];
                    const unauthorizedStudents = [];
                    req.data.students.forEach(sName => {
                        const student = allStudents.find(s => s.name === sName);
                        if (!student) {
                            unauthorizedStudents.push(sName);
                        } else {
                            if (authClasses === '*' || authClasses.includes(student.class)) {
                                authorizedStudents.push(sName);
                            } else {
                                unauthorizedStudents.push(sName);
                            }
                        }
                    });

                    if (authorizedStudents.length === 0) {
                        shouldDisplay = false;
                    } else {
                        content = `${req.requester} 請求為 `;
                        if (authorizedStudents.length > 0) {
                            content += `${authorizedStudents.join('、')}`;
                            if (unauthorizedStudents.length > 0) {
                                content += ` 及其他學生（不在您授權範圍）`;
                            }
                        }
                        content += ` 補點名 (日期：${req.data.date})`;

                        if (unauthorizedStudents.length > 0) {
                            actions = `<span style="color:#b91c1c;">部分學生不在授權範圍，無法批准</span>`;
                        } else {
                            actions = `
                                <button class="btn-sm" onclick="approveRequest('${req.id}')">✅批准</button>
                                <button class="btn-sm" onclick="rejectRequest('${req.id}')">❌拒絕</button>
                            `;
                        }
                    }
                }
            } else if (req.type === 'addClasses') {
                content = `您請求為 ${req.data.name} 增減課堂 (${req.data.classesChange}堂) - 審批中`;
                actions = `<span style="color:#718096;">等待管理員審批</span>`;
            } else if (req.type === 'addStudent') {
                content = `您請求新增學生 ${req.data.name} - 審批中`;
                actions = `<span style="color:#718096;">等待管理員審批</span>`;
            } else if (req.type === 'deleteStudent') {
                content = `您請求刪除學生 ${req.data.name} - 審批中`;
                actions = `<span style="color:#718096;">等待管理員審批</span>`;
            } else if (req.type === 'attendance') {
                if (req.requester === currentUser.username) {
                    content = `您請求為 ${req.data.students.join('、')} 點名 (日期：${req.data.date}) - 審批中`;
                    actions = `<span style="color:#718096;">等待管理員審批</span>`;
                } else {
                    shouldDisplay = false;
                }
            }

            if (shouldDisplay) {
                total++;
                html += `<div class="notification-item">
                    <span class="type-tag">審批</span>
                    <div class="content">${content}</div>
                    <div class="actions">${actions}</div>
                </div>`;
            }
        });
    } else if (currentUser.role === 'assistant') {
        const myRequests = pendingApprovals.filter(req => req.requester === currentUser.username);
        myRequests.forEach(req => {
            total++;
            let content = '';
            if (req.type === 'addClasses') {
                content = `您請求為 ${req.data.name} 增減課堂 (${req.data.classesChange}堂) - 審批中`;
            } else if (req.type === 'addStudent') {
                content = `您請求新增學生 ${req.data.name} - 審批中`;
            } else if (req.type === 'deleteStudent') {
                content = `您請求刪除學生 ${req.data.name} - 審批中`;
            } else if (req.type === 'makeupAttendance') {
                const studentList = req.data.students.join('、');
                content = `您請求為 ${studentList} 補點名 (日期：${req.data.date}) - 審批中`;
            } else if (req.type === 'attendance') {
                const studentList = req.data.students.join('、');
                content = `您請求為 ${studentList} 點名 (日期：${req.data.date}) - 審批中`;
            }
            html += `<div class="notification-item">
                <span class="type-tag">審批中</span>
                <div class="content">${content}</div>
                <div class="actions">
                    <span style="color:#718096;">等待審批</span>
                </div>
            </div>`;
        });
    }

    if (total === 0) {
        html = '<div class="notification-item">目前沒有待辦通知</div>';
    }

    body.innerHTML = html;
    countSpan.textContent = total;
    updateNotificationScrollHint();
}

function uploadPaymentForNewStudent(name, className) {
    pendingNewStudent = { name, className };
    document.getElementById('paymentUploadInput').click();
}

async function loadTrialList() {
    const trials = await fetchWithFallback('getTrialStudents');
    const container = document.getElementById('trialList');
    let html = '';
    trials.forEach(t => {
        html += `<div class="student-row">
            <div class="details">
                <strong>${t.name}</strong> ${t.date} ${t.rentEquipment ? '🛞' : ''} ${t.paid ? '✅已付' : '❌未付'}
                ${t.note ? `<div class="note">📝 ${t.note}</div>` : ''}
            </div>`;
        html += `<div class="actions">`;
        if (currentUser.role === 'admin') {
            html += `<button class="btn-sm" onclick="editTrialDate('${t.name}', '${t.date}')">📅改期</button>`;
            if (!t.paid) {
                html += `<button class="btn-sm" onclick="markTrialPaid('${t.name}', '${t.date}')">💰收費</button>`;
            }
            html += `<button class="btn-sm" onclick="openNoteModalForTrial('${t.name}', '${t.date}')">✏️備註</button>
                     <button class="btn-sm" onclick="confirmDeleteTrial('${t.name}', '${t.date}')">❌刪除</button>`;
        } else {
            html += `<span style="color:#718096;">僅管理員可操作</span>`;
        }
        html += `</div></div>`;
    });
    container.innerHTML = html || '無試堂學生';
}

window.editTrialDate = function(name, originalDate) {
    if (currentUser.role !== 'admin') { showError('無權限'); return; }
    const hiddenPicker = document.getElementById('hiddenDatePicker');
    hiddenPicker.value = originalDate;
    hiddenPicker.style.pointerEvents = 'auto';
    hiddenPicker.style.opacity = '0.01';
    hiddenPicker.focus();
    setTimeout(() => {
        if (hiddenPicker.showPicker) {
            hiddenPicker.showPicker();
        } else {
            hiddenPicker.click();
        }
    }, 200);

    const changeHandler = async function() {
        const newDate = this.value;
        this.removeEventListener('change', changeHandler);
        hiddenPicker.style.pointerEvents = 'none';
        hiddenPicker.style.opacity = '0';
        if (!newDate) return;
        const updates = { date: newDate };
        const result = await fetchWithFallback('updateTrialStudent', { name, date: originalDate, updates: JSON.stringify(updates) });
        if (result.success) {
            showSuccess('日期已更新');
            await loadTrialNotifications();
            await loadTrialList();
        } else {
            showError(result.error);
        }
    };
    hiddenPicker.addEventListener('change', changeHandler);
};

window.openNoteModalForTrial = function(name, date) {
    currentNoteTarget = { type: 'trial', name, date };
    document.getElementById('modalNoteInput').value = '';
    document.getElementById('noteModal').style.display = 'flex';
};

window.confirmDeleteTrial = function(name, date) {
    if (currentUser.role !== 'admin') { showError('無權限'); return; }
    const lockKey = `deleteTrial_${name}_${date}`;
    if (processing[lockKey]) {
        showError('正在處理中，請稍後...');
        return;
    }

    showConfirm(`確定要刪除 ${name} 於 ${date} 的試堂記錄嗎？`, async () => {
        processing[lockKey] = true;
        try {
            const result = await fetchWithFallback('deleteTrialStudent', { name, date });
            if (result.success) {
                showSuccess('刪除成功');
                await loadTrialNotifications();
                await loadTrialList();
            } else {
                showError(result.error || '刪除失敗');
            }
        } catch (err) {
            showError('網路錯誤');
        } finally {
            delete processing[lockKey];
        }
    });
};

window.markTrialPaid = async function(name, date) {
    if (currentUser.role !== 'admin') { showError('無權限'); return; }
    const result = await fetchWithFallback('markTrialPaid', { name, date });
    if (result.success) {
        showSuccess('已標記收費');
        await loadTrialNotifications();
        await loadTrialList();
    } else {
        showError(result.error || '標記失敗');
    }
};

async function addTrial() {
    if (currentUser.role !== 'admin') { showError('無權限'); return; }
    if (processing.addTrial) {
        showError('正在新增中，請稍後...');
        return;
    }
    const btn = document.querySelector('#trial .btn-indigo');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '新增中...';
    }
    processing.addTrial = true;

    try {
        const data = {
            name: document.getElementById('trialName').value,
            date: document.getElementById('trialDate').value,
            rentEquipment: document.getElementById('trialRent').value === 'true',
            paid: document.getElementById('trialPaid').value === 'true',
            note: document.getElementById('trialNote').value
        };
        if (!data.name || !data.date) return showError('姓名與日期必填');
        const result = await fetchWithFallback('addTrialStudent', { data: JSON.stringify(data) });
        if (result.success) {
            showSuccess('新增成功');
            document.getElementById('trialName').value = '';
            document.getElementById('trialDate').value = '';
            document.getElementById('trialNote').value = '';
            await loadTrialNotifications();
            await loadTrialList();
        } else {
            showError(result.error || '新增失敗');
        }
    } catch (err) {
        showError('網路錯誤');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '新增試堂學生';
        }
        delete processing.addTrial;
    }
}

const searchInput = document.getElementById('searchStudentInput');
const dropdown = document.getElementById('studentDropdown');
if (searchInput) {
    searchInput.addEventListener('input', function(e) {
        const kw = e.target.value.trim().toLowerCase();
        if (kw.length < 1) { dropdown.style.display = 'none'; return; }
        const filtered = getFilteredStudents().filter(s => s.name.toLowerCase().includes(kw));  
        if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
        let html = '';
        filtered.forEach(s => {
            const classDisplay = Array.isArray(s.class) ? s.class.join(',') : s.class;
            html += `<div class="dropdown-item" onclick="selectStudent('${s.name}', '${classDisplay}')">${s.name} (${classDisplay}) 剩${s.remainingClasses}堂</div>`;
        });
        dropdown.innerHTML = html;
        dropdown.style.display = 'block';
    });
    document.addEventListener('click', e => {
        if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) dropdown.style.display = 'none';
    });
}

window.selectStudent = function(name, className) {
    document.getElementById('searchStudentInput').value = name;
    document.getElementById('selectedClass').value = className;
    dropdown.style.display = 'none';
};

async function submitAddClasses() {
    if (currentUser.role !== 'admin' && currentUser.role !== 'coach') { showError('無權限'); return; }
    if (processing.addClasses) {
        showError('正在處理中...');
        return;
    }
    const btn = document.querySelector('#addClasses .btn-success');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '提交中...';
    }
    processing.addClasses = true;

    try {
        const name = document.getElementById('searchStudentInput').value.trim();
        const className = document.getElementById('selectedClass').value;
        const delta = parseInt(document.getElementById('addClassDelta').value);
        const reason = document.getElementById('addClassReason').value.trim() || '教練調整';
        if (!name || !className || isNaN(delta)) {
            showError('請完成所有欄位');
            return;
        }
        const payload = { name, class: className, classesChange: delta, reason };

        if (currentUser.role === 'admin') {
            const result = await fetchWithFallback('addClasses', { data: JSON.stringify(payload), operator: currentUser.username });
            if (result.success) {
                showSuccess(result.message);
                document.getElementById('searchStudentInput').value = '';
                document.getElementById('selectedClass').value = '';
                document.getElementById('addClassDelta').value = '10';
                document.getElementById('addClassReason').value = '';
                await fetchAllStudents();
                updateAttendanceList();
                updateRentalList();
                renderNoteListByClass();
            } else {
                showError(result.message);
            }
        } else {
            const result = await fetchWithFallback('submitApprovalRequest', { data: JSON.stringify({ type: 'addClasses', payload }), requester: currentUser.username });
            if (result.success) {
                showSuccess('請求已提交，等待管理員審批');
                document.getElementById('searchStudentInput').value = '';
                document.getElementById('selectedClass').value = '';
                document.getElementById('addClassDelta').value = '10';
                document.getElementById('addClassReason').value = '';
            } else {
                showError(result.error);
            }
        }
    } catch (err) {
        showError('網路錯誤');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '提交審批';
        }
        delete processing.addClasses;
    }
}

// 在 loadAllData 完成後，若 classCollapsed 未定義則設為 true
function renderNoteListByClass() {
    const container = document.getElementById('noteListByClass');
    if (!container) return;

    const filteredStudents = getFilteredStudents();
    const grouped = {};
    filteredStudents.forEach(s => {
        (s.class || []).forEach(className => {
            if (!grouped[className]) grouped[className] = [];
            grouped[className].push(s);
        });
    });

    const fragment = document.createDocumentFragment();
    const sortedClasses = sortClasses(Object.keys(grouped));
    sortedClasses.forEach(className => {
        // 若尚未設定，預設收合
        if (classCollapsed[className] === undefined) {
            classCollapsed[className] = true;
        }
        const isCollapsed = classCollapsed[className];
        const icon = isCollapsed ? '▶' : '▼';

        const header = document.createElement('div');
        header.className = `class-header ${isCollapsed ? 'collapsed' : ''}`;
        header.setAttribute('data-class', className);
        header.onclick = () => toggleClass(className);
        header.innerHTML = `
            <span class="toggle-icon">${icon}</span>
            <h3>${className}班</h3>
        `;
        fragment.appendChild(header);

        const studentsDiv = document.createElement('div');
        studentsDiv.className = `class-students ${isCollapsed ? 'collapsed' : ''}`;
        studentsDiv.id = `class-${className}`;

        grouped[className].forEach(s => {
            const card = document.createElement('div');
            card.className = 'student-card';
            // 卡片內容與原本相同，但改用 DOM 操作
            card.innerHTML = `
                <div class="student-card-header">
                    <div class="student-name-icons">
                        ${(currentUser.role === 'admin' && s.remainingClasses <= 0) ? '<span class="student-icons">🔴</span>' : ''}
                        ${(s.leaveCount >= 2) ? '<span class="student-icons">🟡</span>' : ''}
                        <span class="student-name"><strong>${s.name}</strong></span>
                    </div>
                    <span class="remaining-class ${s.remainingClasses <= 0 ? 'remaining-zero' : ''}">${s.remainingClasses} 堂</span>
                </div>
                <div class="student-stats">
                    <span class="leave-badge">請假 ${s.leaveCount}</span>
                    <span class="rental-badge">租借 ${s.rentalCount}</span>
                </div>
                ${s.note ? `<div class="student-note">📝 ${s.note}</div>` : ''}
                <div class="student-actions">
                    ${getStudentActions(s.name)}
                </div>
            `;
            studentsDiv.appendChild(card);
        });
        fragment.appendChild(studentsDiv);
    });

    container.innerHTML = '';
    container.appendChild(fragment);
}

window.toggleClass = function(className) {
    classCollapsed[className] = !classCollapsed[className];
    renderNoteListByClass();
};

window.openNoteModalForStudent = function(name) {
    currentNoteTarget = { type: 'student', name };
    const student = allStudents.find(s => s.name === name);
    document.getElementById('modalNoteInput').value = student?.note || '';
    document.getElementById('noteModal').style.display = 'flex';
};

async function saveNote() {
    if (!currentNoteTarget) {
        closeNoteModal();
        return;
    }
    const newNote = document.getElementById('modalNoteInput').value.trim();
    const { type, name, date } = currentNoteTarget;
    const lockKey = `note_${type}_${name}${date ? '_'+date : ''}`;
    if (processing[lockKey]) {
        showError('正在處理中，請稍後...');
        return;
    }
    processing[lockKey] = true;

    const saveBtn = document.getElementById('saveNoteBtn');
    const cancelBtn = document.querySelector('#noteModal .cancel');
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = '儲存中...';

    try {
        if (type === 'student') {
            const updates = { note: newNote };
            const result = await fetchWithFallback('updateStudentNote', { name, updates: JSON.stringify(updates) });
            if (result.success) {
                showSuccess('備註已更新');
                await fetchAllStudents();
                renderNoteListByClass();
            } else {
                showError(result.error || '更新失敗');
            }
        } else if (type === 'trial') {
            const updates = { note: newNote };
            const result = await fetchWithFallback('updateTrialStudent', { name, date, updates: JSON.stringify(updates) });
            if (result.success) {
                showSuccess('備註已更新');
                await loadTrialNotifications();
                await loadTrialList();
            } else {
                showError(result.error || '更新失敗');
            }
        }
    } catch (err) {
        showError('網路錯誤');
    } finally {
        delete processing[lockKey];
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = '儲存';
        closeNoteModal();
    }
}

window.confirmDeleteStudent = function(name) {
    if (currentUser.role !== 'admin' && currentUser.role !== 'coach') { showError('無權限'); return; }
    const lockKey = `deleteStudent_${name}`;
    if (processing[lockKey]) {
        showError('正在處理中，請稍後...');
        return;
    }

    showConfirm(`確定要刪除 ${name}？該操作只能從備份逆轉。`, () => {
        showConfirm(`真的要刪除 ${name} 嗎？此操作無法復原，僅能從備份還原。`, async () => {
            processing[lockKey] = true;
            try {
                const result = await fetchWithFallback('deleteStudent', { name });
                if (result.success) {
                    showSuccess(`${name} 已刪除`);
                    await fetchAllStudents();
                    renderNoteListByClass();
                    updateAttendanceList();
                    updateRentalList();
                } else {
                    showError(result.error || '刪除失敗');
                }
            } catch (err) {
                showError('網路錯誤');
            } finally {
                delete processing[lockKey];
            }
        });
    });
};

const coachSearch = document.getElementById('coachLeaveSearchInput');
const coachDropdown = document.getElementById('coachLeaveDropdown');
if (coachSearch) {
    coachSearch.addEventListener('input', function(e) {
        const kw = e.target.value.trim().toLowerCase();
        if (kw.length < 1) { coachDropdown.style.display = 'none'; return; }
        const filtered = getFilteredStudents().filter(s => s.name.toLowerCase().includes(kw));
        if (filtered.length === 0) { coachDropdown.style.display = 'none'; return; }
        let html = '';
        filtered.forEach(s => {
            const classDisplay = Array.isArray(s.class) ? s.class.join(',') : s.class;
            html += `<div class="dropdown-item" onclick="selectCoachLeave('${s.name}', '${classDisplay}')">${s.name} (${classDisplay}) 請假${s.leaveCount}次</div>`;
        });
        coachDropdown.innerHTML = html;
        coachDropdown.style.display = 'block';
    });
    document.addEventListener('click', e => {
        if (!coachSearch.contains(e.target) && !coachDropdown.contains(e.target)) coachDropdown.style.display = 'none';
    });
}
window.selectCoachLeave = function(name, className) {
    document.getElementById('coachLeaveSearchInput').value = name;
    document.getElementById('coachLeaveSelectedClass').value = className;
    coachDropdown.style.display = 'none';
};
async function coachRequestDeleteStudent(name) {
    if (currentUser.role !== 'coach') {
        showError('無權限');
        return;
    }
    
    showConfirm(`確定要請求刪除學生 ${name} 嗎？此操作需要管理員審批。`, async () => {
        const lockKey = `requestDelete_${name}`;
        if (processing[lockKey]) {
            showError('正在處理中，請稍後...');
            return;
        }
        processing[lockKey] = true;

        try {
            const payload = { name };
            const result = await fetchWithFallback('submitApprovalRequest', { 
                data: JSON.stringify({ type: 'deleteStudent', payload }), 
                requester: currentUser.username 
            });
            if (result.success) {
                showSuccess('刪除請求已提交，等待管理員審批');
            } else {
                showError(result.error || '提交失敗');
            }
        } catch (err) {
            showError('網路錯誤');
        } finally {
            delete processing[lockKey];
        }
    });
}
async function submitCoachLeave() {
    if (currentUser.role !== 'admin' && currentUser.role !== 'coach') { showError('無權限'); return; }
    if (processing.coachLeave) {
        showError('正在處理中...');
        return;
    }
    const btn = document.querySelector('#coachLeave .btn-purple');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '處理中...';
    }
    processing.coachLeave = true;

    try {
        const name = document.getElementById('coachLeaveSearchInput').value.trim();
        const className = document.getElementById('coachLeaveSelectedClass').value;
        let leaveDate = document.getElementById('coachLeaveDate').value;
        if (!leaveDate) {
            leaveDate = getTodayUTC8();
        }

        if (!name || !className) {
            showError('請選擇學生');
            return;
        }
        const student = allStudents.find(s => s.name === name);
        let msg = `確定為 ${name} 提交請假？\n請假日期：${leaveDate}`;
        if (student && student.leaveCount >= 2) msg += '\n⚠️ 將扣1堂課！';
        showConfirm(msg, async () => {
            const result = await fetchWithFallback('coachSubmitLeave', { name, operator: currentUser.username, date: leaveDate });
            if (result.success) {
                showSuccess(`請假成功！請假次數: ${result.leaveCount}，剩餘: ${result.remaining}`);
                await fetchAllStudents();
                updateAttendanceList();
                renderNoteListByClass();
                document.getElementById('coachLeaveSearchInput').value = '';
                document.getElementById('coachLeaveSelectedClass').value = '';
                document.getElementById('coachLeaveDate').value = '';
            } else {
                showError(result.error || '請假失敗');
            }
        });
    } catch (err) {
        showError('網路錯誤');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '提交請假';
        }
        delete processing.coachLeave;
    }
}

function renderClassSelection() {
    const container = document.getElementById('classSelectionContainer');
    if (!container) return;
    let html = '';
    allClasses.forEach(className => {
        const isSelected = selectedClasses.has(className);
        html += `<span class="class-badge" style="cursor:pointer; background:${isSelected ? '#48bb78' : '#4299e1'};" onclick="toggleClassSelection('${className}')">${className} ${isSelected ? '✓' : ''}</span>`;
    });
    container.innerHTML = html;
    updateSelectedClassesDisplay();
}

function toggleClassSelection(className) {
    if (selectedClasses.has(className)) {
        selectedClasses.delete(className);
    } else {
        selectedClasses.add(className);
    }
    renderClassSelection();
}

function clearAllSelectedClasses() {
    selectedClasses.clear();
    renderClassSelection();
}

function updateSelectedClassesDisplay() {
    const displaySpan = document.getElementById('selectedClassesDisplay');
    const hiddenInput = document.getElementById('newAuthClasses');
    if (!displaySpan || !hiddenInput) return;
    const classesArray = Array.from(selectedClasses);
    displaySpan.textContent = classesArray.length ? `已選：${classesArray.join(', ')}` : '尚未選取任何班級';
    hiddenInput.value = classesArray.join(',');
}

async function loadUserList() {
    if (currentUser.role !== 'admin') return;
    const users = await fetchWithFallback('getAllUsers');
    const container = document.getElementById('userList');
    let html = '';
    users.forEach(u => {
        let roleName = '助教';
        if (u.role === 'admin') roleName = '管理員';
        else if (u.role === 'coach') roleName = '教練';
        html += `<div class="student-row">
            <div class="details">
                <strong>${u.username}</strong> (${roleName})<br>
                <span style="font-size:0.85rem;">班級: ${u.authorizedClasses === '*' ? '全部' : u.authorizedClasses}</span><br>
                <span style="font-size:0.85rem;">密碼: ${u.password}</span>
            </div>
            <div class="actions">
                <button class="btn-sm" onclick="openEditUserModal('${u.username}', '${u.password}', '${u.role}', '${u.authorizedClasses}')">✏️編輯</button>
                <button class="btn-sm" onclick="confirmDeleteUser('${u.username}')">❌刪除</button>
            </div>
        </div>`;
    });
    container.innerHTML = html || '尚無用戶';
}

function openChangePasswordModal() {
    document.getElementById('changePasswordModal').style.display = 'flex';
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword1').value = '';
    document.getElementById('newPassword2').value = '';
}

function closeChangePasswordModal() {
    document.getElementById('changePasswordModal').style.display = 'none';
}

async function submitChangePassword() {
    const oldPwd = document.getElementById('oldPassword').value.trim();
    const newPwd1 = document.getElementById('newPassword1').value.trim();
    const newPwd2 = document.getElementById('newPassword2').value.trim();

    if (!oldPwd || !newPwd1 || !newPwd2) {
        showError('請填寫所有欄位');
        return;
    }
    if (newPwd1 !== newPwd2) {
        showError('兩次新密碼不一致');
        return;
    }

    const verifyData = await fetchWithFallback('verifyUser', { username: currentUser.username, password: oldPwd });
    if (!verifyData.success) {
        showError('舊密碼錯誤');
        return;
    }

    const updates = { password: newPwd1 };
    const updateData = await fetchWithFallback('updateUser', { username: currentUser.username, updates: JSON.stringify(updates) });
    if (updateData.success) {
        showSuccess('密碼修改成功');
        closeChangePasswordModal();
    } else {
        showError(updateData.error || '修改失敗');
    }
}

async function addUser() {
    if (currentUser.role !== 'admin') return;
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value.trim();
    const role = document.getElementById('newRole').value;
    
    const classesArray = Array.from(selectedClasses);
    let authClasses = classesArray.join(',');
    if (classesArray.length === allClasses.length) {
        authClasses = '*';
    }

    if (!username || !password) { showError('請填寫用戶名與密碼'); return; }
    
    const addBtn = document.getElementById('addUserBtn');
    const originalText = addBtn.textContent;
    addBtn.disabled = true;
    addBtn.textContent = '新增中...';

    const data = {
        username,
        password,
        role,
        authorizedClasses: authClasses
    };
    try {
        const result = await fetchWithFallback('addUser', { data: JSON.stringify(data) });
        if (result.success) {
            showSuccess('用戶新增成功');
            document.getElementById('newUsername').value = '';
            document.getElementById('newPassword').value = '123456';
            selectedClasses.clear();
            renderClassSelection();
            loadUserList();
        } else {
            showError(result.error || '新增失敗');
        }
    } catch (err) {
        showError('網路錯誤');
    } finally {
        addBtn.disabled = false;
        addBtn.textContent = originalText;
    }
}

function openEditUserModal(username, password, role, authClasses) {
    document.getElementById('editUsername').value = username;
    document.getElementById('editPassword').value = '';
    document.getElementById('editRole').value = role;

    selectedClasses.clear();
    if (authClasses === '*') {
        allClasses.forEach(c => selectedClasses.add(c));
    } else {
        authClasses.split(',').forEach(c => {
            if (c.trim()) selectedClasses.add(c.trim());
        });
    }
    renderEditClassSelection();
    document.getElementById('editUserModal').style.display = 'flex';
}

function renderEditClassSelection() {
    const container = document.getElementById('editClassSelectionContainer');
    if (!container) return;
    let html = '';
    allClasses.forEach(className => {
        const isSelected = selectedClasses.has(className);
        html += `<span class="class-badge" style="cursor:pointer; background:${isSelected ? '#48bb78' : '#4299e1'};" onclick="toggleEditClassSelection('${className}')">${className} ${isSelected ? '✓' : ''}</span>`;
    });
    container.innerHTML = html;
    updateEditSelectedClassesDisplay();
}

function toggleEditClassSelection(className) {
    if (selectedClasses.has(className)) {
        selectedClasses.delete(className);
    } else {
        selectedClasses.add(className);
    }
    renderEditClassSelection();
}

function clearEditSelectedClasses() {
    selectedClasses.clear();
    renderEditClassSelection();
}

function updateEditSelectedClassesDisplay() {
    const displaySpan = document.getElementById('editSelectedClassesDisplay');
    const hiddenInput = document.getElementById('editAuthClasses');
    if (!displaySpan || !hiddenInput) return;
    const classesArray = Array.from(selectedClasses);
    displaySpan.textContent = classesArray.length ? `已選：${classesArray.join(', ')}` : '尚未選取任何班級';
    hiddenInput.value = classesArray.join(',');
}

async function saveUserEdit() {
    const username = document.getElementById('editUsername').value;
    const password = document.getElementById('editPassword').value.trim();
    const role = document.getElementById('editRole').value;
    
    const classesArray = Array.from(selectedClasses);
    let authClasses = classesArray.join(',');
    if (classesArray.length === allClasses.length) {
        authClasses = '*';
    }

    const updates = {};
    if (password) updates.password = password;
    updates.role = role;
    updates.authorizedClasses = authClasses;

    const saveBtn = document.querySelector('#editUserModal .confirm');
    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '儲存中...';

    try {
        const result = await fetchWithFallback('updateUser', { username, updates: JSON.stringify(updates) });
        if (result.success) {
            showSuccess('用戶資料已更新');
            closeEditUserModal();
            loadUserList();
        } else {
            showError(result.error || '更新失敗');
        }
    } catch (err) {
        showError('網路錯誤');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    }
}

function closeEditUserModal() {
    document.getElementById('editUserModal').style.display = 'none';
    selectedClasses.clear();
}

function confirmDeleteUser(username) {
    if (currentUser.role !== 'admin') return;
    showConfirm(`確定要刪除用戶 ${username} 嗎？`, () => deleteUser(username));
}

async function deleteUser(username) {
    const result = await fetchWithFallback('deleteUser', { username });
    if (result.success) {
        showSuccess('用戶已刪除');
        loadUserList();
    } else {
        showError(result.error || '刪除失敗');
    }
}

async function approveRequest(id) {
    const result = await fetchWithFallback('approveRequest', { id, approver: currentUser.username });
    if (result.success) {
        showSuccess('請求已批准');
        await loadPendingApprovals();
        await fetchAllStudents();
        renderNoteListByClass();
        updateAttendanceList();
        updateRentalList();
    } else {
        showError(result.error || '批准失敗');
    }
}

async function rejectRequest(id) {
    const result = await fetchWithFallback('rejectRequest', { id, approver: currentUser.username });
    if (result.success) {
        showSuccess('請求已拒絕');
        await loadPendingApprovals();
    } else {
        showError(result.error || '拒絕失敗');
    }
}

document.getElementById('paymentUploadInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) {
        showError('請選擇圖片檔案');
        return;
    }
    if (!file.type.startsWith('image/')) {
        showError('請選擇圖片格式的檔案');
        this.value = '';
        return;
    }
    selectedPaymentFile = file;
    console.log('✅ 已選擇繳費憑證：', file.name, '大小：', file.size, '類型：', file.type);
    
    if (pendingNewStudent) {
        openPaymentStudentModal(pendingNewStudent.name, pendingNewStudent.className);
        pendingNewStudent = null;
    } else {
        openPaymentStudentModal();
    }
});

function openPaymentStudentModal(prefillName = '', prefillClass = '') {
    document.getElementById('paymentStudentSearch').value = prefillName;
    document.getElementById('paymentSelectedClass').value = prefillClass;
    document.getElementById('paymentDate').value = getTodayUTC8();
    if (prefillName && prefillClass) {
        selectedPaymentStudent = prefillName;
        selectedPaymentClass = prefillClass;
    }
    document.getElementById('paymentStudentModal').style.display = 'flex';
    setupPaymentSearch();
}

function closePaymentModal() {
    document.getElementById('paymentStudentModal').style.display = 'none';
}

function setupPaymentSearch() {
    const searchInput = document.getElementById('paymentStudentSearch');
    const dropdown = document.getElementById('paymentStudentDropdown');
    const newInput = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newInput, searchInput);
    newInput.addEventListener('input', function(e) {
        const kw = e.target.value.trim().toLowerCase();
        if (kw.length < 1) { dropdown.style.display = 'none'; return; }
        const filtered = getFilteredStudents().filter(s => s.name.toLowerCase().includes(kw));
        if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
        let html = '';
        filtered.forEach(s => {
            const classDisplay = Array.isArray(s.class) ? s.class.join(',') : s.class;
            html += `<div class="dropdown-item" onclick="selectPaymentStudent('${s.name}', '${classDisplay}')">${s.name} (${classDisplay})</div>`;
        });
        dropdown.innerHTML = html;
        dropdown.style.display = 'block';
    });
    document.addEventListener('click', function(e) {
        if (!newInput.contains(e.target) && !dropdown.contains(e.target)) dropdown.style.display = 'none';
    });
}

window.selectPaymentStudent = function(name, className) {
    document.getElementById('paymentStudentSearch').value = name;
    document.getElementById('paymentSelectedClass').value = className;
    selectedPaymentStudent = name;
    selectedPaymentClass = className;
    document.getElementById('paymentStudentDropdown').style.display = 'none';
};

function confirmPaymentUpload() {
    const student = selectedPaymentStudent || document.getElementById('paymentStudentSearch').value.trim();
    const className = selectedPaymentClass || document.getElementById('paymentSelectedClass').value;
    const paymentDate = document.getElementById('paymentDate').value;
    
    console.log('📋 確認上傳，selectedPaymentFile =', selectedPaymentFile);

    if (!student || !className || !paymentDate) {
        showError('請填寫完整資料');
        return;
    }
    if (!selectedPaymentFile) {
        showError('請先選擇繳費憑證圖片');
        closePaymentModal();
        document.getElementById('paymentUploadInput').value = '';
        return;
    }
    closePaymentModal();

    showConfirm(`學生：${student}\n班級：${className}\n繳費日期：${paymentDate}\n確定上傳？`, () => uploadPaymentPhoto(student, className, paymentDate));
}

async function uploadPaymentPhoto(studentName, className, paymentDate) {
    if (!selectedPaymentFile) {
        showError('沒有選擇繳費憑證');
        return;
    }

    showLoadingSpinner('💰 繳費憑證上傳中，請勿關閉頁面...');

    try {
        console.log('開始壓縮繳費圖片');
        const compressedBase64 = await compressImage(selectedPaymentFile);
        console.log('壓縮完成，長度：', compressedBase64.length);

        const params = new URLSearchParams({
            imageData: compressedBase64,
            fileName: selectedPaymentFile.name,
            uploader: currentUser.username,
            studentName: studentName,
            class: className,
            paymentDate: paymentDate
        });

        console.log('發送請求至後端');
        const result = await fetchWithFallback('uploadPaymentPhoto', {}, 'POST', params);
        console.log('後端回應：', result);

        if (result.success) {
            showSuccess('繳費憑證上傳成功！');
            await loadPaymentNotifications();
            newStudentNotifications = newStudentNotifications.filter(n => n.name !== studentName);
            renderNotificationBody();
        } else {
            showError(result.error || '上傳失敗');
        }
    } catch (err) {
        console.error('上傳過程錯誤：', err);
        showError('網路錯誤：' + err.message);
    } finally {
        hideLoadingSpinner();
        selectedPaymentFile = null;
        document.getElementById('paymentUploadInput').value = '';
    }
}

document.getElementById('photoUploadInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) {
        showError('請選擇圖片檔案');
        return;
    }
    if (!file.type.startsWith('image/')) {
        showError('請選擇圖片格式的檔案');
        this.value = '';
        return;
    }
    selectedPhotoFile = file;
    console.log('已選擇相片：', file.name);
    openClassSelectModal();
});

function openClassSelectModal() {
    const select = document.getElementById('photoClassSelect');
    select.innerHTML = '<option value="">-- 請選擇班級 --</option>';
    const allowedClasses = getAuthorizedClasses();
    let classList = allowedClasses === '*' ? allClasses : allowedClasses;
    classList.forEach(className => {
        const option = document.createElement('option');
        option.value = className;
        option.textContent = className;
        select.appendChild(option);
    });
    document.getElementById('classSelectModal').style.display = 'flex';
}

function closeClassSelectModal() {
    document.getElementById('classSelectModal').style.display = 'none';
}

function confirmClassSelection() {
    const selectedClass = document.getElementById('photoClassSelect').value;
    if (!selectedClass) {
        showError('請選擇班級');
        return;
    }
    if (!selectedPhotoFile) {
        showError('沒有選擇照片，請重新選擇檔案');
        closeClassSelectModal();
        return;
    }
    closeClassSelectModal();
    showConfirm(`您選擇的班級是「${selectedClass}」，確定要上傳這張照片嗎？`, () => uploadPhoto(selectedClass));
}

async function uploadPhoto(className) {
    if (!selectedPhotoFile) {
        showError('沒有選擇照片');
        return;
    }

    showLoadingSpinner('📸 相片上傳中，請勿關閉頁面...');

    try {
        console.log('開始壓縮圖片');
        const compressedBase64 = await compressImage(selectedPhotoFile);
        console.log('壓縮完成，長度：', compressedBase64.length);

        const params = new URLSearchParams({
            imageData: compressedBase64,
            fileName: selectedPhotoFile.name,
            uploader: currentUser.username,
            class: className
        });

        console.log('發送請求至後端');
        const result = await fetchWithFallback('uploadPhoto', {}, 'POST', params);
        console.log('後端回應：', result);

        if (result.success) {
            showSuccess('相片上傳成功！');
        } else {
            showError(result.error || '上傳失敗');
        }
    } catch (err) {
        console.error('上傳過程錯誤：', err);
        showError('網路錯誤：' + err.message);
    } finally {
        hideLoadingSpinner();
        selectedPhotoFile = null;
        document.getElementById('photoUploadInput').value = '';
    }
}

function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (readerEvent) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const maxSize = 1600;
                if (width > height && width > maxSize) {
                    height *= maxSize / width;
                    width = maxSize;
                } else if (height > maxSize) {
                    width *= maxSize / height;
                    height = maxSize;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const compressedBase64 = canvas.toDataURL('image/jpeg', 0.8);
                resolve(compressedBase64);
            };
            img.onerror = reject;
            img.src = readerEvent.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function closeNoteModal() {
    document.getElementById('noteModal').style.display = 'none';
    currentNoteTarget = null;
    const saveBtn = document.getElementById('saveNoteBtn');
    const cancelBtn = document.querySelector('#noteModal .cancel');
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '儲存';
    }
    if (cancelBtn) cancelBtn.disabled = false;
}

function closeConfirmModal() {
    document.getElementById('confirmModal').style.display = 'none';
    const confirmBtn = document.getElementById('confirmBtn');
    const cancelBtn = document.querySelector('#confirmModal .cancel');
    confirmBtn.disabled = false;
    confirmBtn.textContent = '確定';
    cancelBtn.disabled = false;
    currentConfirmCallback = null;
}

function closeAlertModal() {
    document.getElementById('alertModal').style.display = 'none';
}

function showLoadingSpinner(message) {
    const spinner = document.getElementById('loadingSpinner');
    const p = spinner.querySelector('p');
    if (p) p.textContent = message || '載入中，請稍後...';
    spinner.style.display = 'flex';
}

function hideLoadingSpinner() {
    document.getElementById('loadingSpinner').style.display = 'none';
}

function showSuccess(msg) {
    const msgDiv = document.getElementById('message');
    msgDiv.innerHTML = `<div class="success">✅ ${msg}</div>`;
    setTimeout(() => msgDiv.innerHTML = '', 4000);
}

function showError(msg) {
    const msgDiv = document.getElementById('message');
    msgDiv.innerHTML = `<div class="error">❌ ${msg}</div>`;
    setTimeout(() => msgDiv.innerHTML = '', 4000);
}

window.addEventListener('DOMContentLoaded', async function() {
    const editClassModal = document.getElementById('editStudentClassModal');
    if (editClassModal) {
        editClassModal.addEventListener('click', function(e) {
            if (e.target === editClassModal) closeEditClassModal();
        });
    }
    const alertModal = document.getElementById('alertModal');
    if (alertModal) {
        alertModal.addEventListener('click', function(e) {
            if (e.target === alertModal) closeAlertModal();
        });
    }
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';

            let roleName = '助教';
            if (currentUser.role === 'admin') roleName = '管理員';
            else if (currentUser.role === 'coach') roleName = '教練';
            document.getElementById('userInfoDisplay').textContent = `👤 ${currentUser.username} (${roleName})`;

            document.getElementById('loadingSpinner').style.display = 'flex';
            document.getElementById('appContent').style.display = 'none';
            await loadAllData();
        } catch (e) {
            console.error('自動登入失敗', e);
            localStorage.removeItem('currentUser');
        }
    }

    const renewModal = document.getElementById('renewQuantityModal');
    if (renewModal) {
        renewModal.addEventListener('click', function(e) {
            if (e.target === renewModal) closeRenewQuantityModal();
        });
    }

    const addStudentModal = document.getElementById('addStudentQuantityModal');
    if (addStudentModal) {
        addStudentModal.addEventListener('click', function(e) {
            if (e.target === addStudentModal) closeAddStudentQuantityModal();
        });
    }

    const modal = document.getElementById('coachStudentRecordModal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                closeCoachStudentModal();
            }
        });
    }
    // 事件委託：點名區塊的按鈕點擊處理
    const attendanceList = document.getElementById('attendanceList');
    if (attendanceList) {
        attendanceList.addEventListener('click', function(e) {
            const btn = e.target.closest('.student-button');
            if (!btn) return;
            if (btn.disabled) return;

            const name = btn.getAttribute('data-name');
            if (!name) return;

            if (isMakeupMode) {
                // 補點名模式：所有角色都使用 toggle 選取
                toggleMakeupStudent(name);
            } else {
                // 一般點名模式
                toggleAttendanceStudent(name);
            }
        });
    }
});
