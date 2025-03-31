const socket = io('http://localhost:3000');
let currentUser = null;
let currentChat = null;
let peers = {};

// DOM Elements
const authScreen = document.getElementById('auth-screen');
const appScreen = document.getElementById('app');
const employeeIdInput = document.getElementById('employee-id');
const nameInput = document.getElementById('name');
const loginBtn = document.getElementById('login-btn');
const chatList = document.getElementById('chat-list');
const messageInput = document.getElementById('message-text');
const sendButton = document.getElementById('send-message');
const attachButton = document.getElementById('attach-file');
const fileInput = document.getElementById('file-input');
const newGroupBtn = document.getElementById('new-group-btn');
const currentChatName = document.getElementById('current-chat-name');
const messagesContainer = document.getElementById('messages');

// Authentication
loginBtn.addEventListener('click', () => {
  console.group('Authentication Process');
  console.log('Login button clicked');
  const employee_id = employeeIdInput.value.trim();
  const name = nameInput.value.trim();

  if (!employee_id || !name) {
    console.warn('Login attempted with missing fields', { employee_id, name });
    alert('Please enter both Employee ID and Name');
    console.groupEnd();
    return;
  }

  console.log('Attempting authentication for:', { employee_id, name });
  socket.emit('authenticate', { employee_id, name });
  console.groupEnd();
});

socket.on('auth_response', (response) => {
  console.group('Authentication Response');
  console.log('Received auth response:', response);
  if (response.success) {
    console.log('Authentication successful for user:', response);
    currentUser = response;
    authScreen.style.display = 'none';
    appScreen.style.display = 'flex';
    loadChats();
  } else {
    console.error('Authentication failed:', response.error);
    console.trace('Authentication failure stack trace');
    alert('Authentication failed: ' + response.error);
  }
  console.groupEnd();
});

// Chat Management
function loadChats() {
  console.log('Loading chats...');
  // Clear existing chats
  chatList.innerHTML = '';

  // Add online users
  console.log('Requesting users list...');
  socket.emit('get_users');
  
  // Add existing groups
  console.log('Requesting groups list...');
  socket.emit('get_groups');
}

socket.on('users_list', (users) => {
  console.log('Received users list:', users);
  users.forEach(user => {
    if (user.id !== currentUser.id) {
      console.log('Adding user to chat list:', user);
      addChatItem(user.name, user.id, 'user');
    }
  });
});

socket.on('groups_list', (groups) => {
  console.log('Received groups list:', groups);
  groups.forEach(group => {
    console.log('Adding group to chat list:', group);
    addChatItem(group.name, group.id, 'group');
  });
});

function addChatItem(name, id, type) {
  const chatItem = document.createElement('div');
  chatItem.className = 'chat-item';
  chatItem.textContent = name;
  chatItem.dataset.id = id;
  chatItem.dataset.type = type;
  chatItem.dataset.name = name;

  chatItem.addEventListener('click', () => {
    currentChat = { id, type, name };
    currentChatName.textContent = name;
    socket.emit('get_chat_history', {
      user_id: currentUser.id,
      chat_id: id,
      chat_type: type
    });
    messagesContainer.innerHTML = '';
  });

  chatList.appendChild(chatItem);
}

// Messaging
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
  console.group('Message Sending');
  console.log('Attempting to send message...');
  if (!currentChat) {
    console.warn('Cannot send message: No chat selected', { currentChat });
    console.groupEnd();
    return;
  }

  const content = messageInput.value.trim();
  if (!content) {
    console.warn('Cannot send message: Empty message');
    console.groupEnd();
    return;
  }

  const messageData = {
    sender_id: currentUser.id,
    content,
    type: 'text'
  };

  if (currentChat.type === 'user') {
    messageData.receiver_id = currentChat.id;
    socket.emit('direct_message', messageData);
  } else {
    messageData.group_id = currentChat.id;
    socket.emit('group_message', messageData);
  }

  messageInput.value = '';
  addMessageToUI(messageData, true);
}

function addMessageToUI(message, sent = false) {
  const messageElement = document.createElement('div');
  messageElement.className = `message ${sent ? 'sent' : 'received'}`;
  messageElement.textContent = message.content;
  messagesContainer.appendChild(messageElement);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

socket.on('new_message', (message) => {
  if (currentChat && 
      currentChat.type === 'user' && 
      ((message.sender_id === currentChat.id && message.receiver_id === currentUser.id) ||
       (message.sender_id === currentUser.id && message.receiver_id === currentChat.id))) {
    addMessageToUI(message, message.sender_id === currentUser.id);
  }
});

socket.on('new_group_message', (message) => {
  if (currentChat && 
      currentChat.type === 'group' && 
      message.group_id === currentChat.id) {
    addMessageToUI(message, message.sender_id === currentUser.id);
  }
});

// File Sharing
attachButton.addEventListener('click', () => {
  fileInput.click();
});

function createFileTransferMessage(fileName, status = 'pending') {
  const messageElement = document.createElement('div');
  messageElement.className = `message sent file-transfer ${status}`;
  
  const fileInfo = document.createElement('div');
  fileInfo.className = 'file-info';
  fileInfo.innerHTML = `
    <span class="file-name">${fileName}</span>
    <div class="transfer-status">${status}</div>
    <div class="progress-bar"><div class="progress"></div></div>
  `;
  
  messageElement.appendChild(fileInfo);
  return messageElement;
}

function updateFileTransferProgress(messageElement, progress) {
  const progressBar = messageElement.querySelector('.progress');
  progressBar.style.width = `${progress}%`;
}

fileInput.addEventListener('change', async (e) => {
  console.log('File selected:', e.target.files[0]);
  const file = e.target.files[0];
  if (!file) {
    console.warn('No file selected');
    return;
  }

  if (!currentChat) {
    console.warn('Cannot send file: No chat selected');
    alert('Please select a chat first');
    return;
  }
  
  console.log('Initiating file transfer for:', file.name);

  const messageElement = createFileTransferMessage(file.name);
  messagesContainer.appendChild(messageElement);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    // Create a new peer connection for file transfer
    const peer = new SimplePeer({ initiator: true });
    const chunkSize = 16384; // 16KB chunks
    let offset = 0;
    let sentBytes = 0;

    peer.on('error', err => {
      console.error('Peer connection error:', err);
      messageElement.querySelector('.transfer-status').textContent = 'Failed';
      messageElement.classList.remove('pending');
      messageElement.classList.add('failed');
      console.error('File transfer failed for file:', file.name);
    });

    peer.on('signal', data => {
      console.log('Generated peer signal for file transfer');
      socket.emit('file_transfer_signal', {
        signal: data,
        receiver_id: currentChat.id,
        sender_id: currentUser.id,
        fileName: file.name,
        fileSize: file.size
      });
      console.log('Sent file transfer signal to receiver:', currentChat.id);
    });

    peer.on('connect', () => {
      console.log('Peer connection established for file transfer');
      const reader = new FileReader();
      
      function sendChunk() {
        console.log('Sending file chunk, offset:', offset);
        if (offset >= file.size) {
          peer.send(JSON.stringify({ type: 'end' }));
          messageElement.querySelector('.transfer-status').textContent = 'Sent';
          messageElement.classList.remove('pending');
          messageElement.classList.add('completed');
          return;
        }

        const chunk = file.slice(offset, offset + chunkSize);
        reader.readAsArrayBuffer(chunk);
      }

      reader.onload = (e) => {
        peer.send(e.target.result);
        offset += e.target.result.byteLength;
        sentBytes += e.target.result.byteLength;
        
        const progress = Math.round((sentBytes / file.size) * 100);
        updateFileTransferProgress(messageElement, progress);
        
        setTimeout(sendChunk, 0);
      };

      sendChunk();
    });

    peers[currentChat.id] = peer;
  } catch (err) {
    messageElement.querySelector('.transfer-status').textContent = 'Failed';
    messageElement.classList.remove('pending');
    messageElement.classList.add('failed');
    console.error('File transfer setup error:', err);
  }
});

socket.on('file_transfer_signal', data => {
  if (data.receiver_id === currentUser.id) {
    let peer = peers[data.sender_id];
    
    if (!peer) {
      const messageElement = createFileTransferMessage(data.fileName);
      messageElement.classList.add('received');
      messageElement.classList.remove('sent');
      messagesContainer.appendChild(messageElement);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;

      let receivedBytes = 0;
      let chunks = [];

      peer = new SimplePeer();
      peer.on('data', chunk => {
        try {
          // Check if it's the end signal
          const endSignal = JSON.parse(chunk.toString());
          if (endSignal.type === 'end') {
            const blob = new Blob(chunks);
            const url = URL.createObjectURL(blob);
            
            messageElement.querySelector('.transfer-status').textContent = 'Received';
            messageElement.classList.remove('pending');
            messageElement.classList.add('completed');

            const downloadLink = document.createElement('a');
            downloadLink.href = url;
            downloadLink.download = data.fileName;
            downloadLink.className = 'download-link';
            downloadLink.textContent = 'Download';
            messageElement.appendChild(downloadLink);

            chunks = [];
            return;
          }
        } catch {
          // Not an end signal, process as chunk
          chunks.push(chunk);
          receivedBytes += chunk.byteLength;
          
          const progress = Math.round((receivedBytes / data.fileSize) * 100);
          updateFileTransferProgress(messageElement, progress);
        }
      });

      peer.on('error', err => {
        messageElement.querySelector('.transfer-status').textContent = 'Failed';
        messageElement.classList.remove('pending');
        messageElement.classList.add('failed');
        console.error('File transfer error:', err);
      });

      peers[data.sender_id] = peer;
    }

    peer.signal(data.signal);
  }
});

// Group Creation
const groupModalOverlay = document.getElementById('group-modal-overlay');
const groupNameInput = document.getElementById('group-name');
const membersList = document.getElementById('members-list');
const cancelGroupBtn = document.getElementById('cancel-group');
const createGroupBtn = document.getElementById('create-group');

function showGroupModal() {
  groupModalOverlay.style.display = 'flex';
  groupNameInput.value = '';
  membersList.innerHTML = '';
  
  // Populate members list
  const users = Array.from(chatList.children);
  users.forEach(user => {
    if (user.dataset.type === 'user') {
      const memberItem = document.createElement('div');
      memberItem.className = 'member-item';
      memberItem.innerHTML = `
        <input type="checkbox" value="${user.dataset.id}">
        <span>${user.dataset.name}</span>
      `;
      membersList.appendChild(memberItem);
    }
  });
}

function hideGroupModal() {
  groupModalOverlay.style.display = 'none';
}

newGroupBtn.addEventListener('click', showGroupModal);
cancelGroupBtn.addEventListener('click', hideGroupModal);

createGroupBtn.addEventListener('click', () => {
  const groupName = groupNameInput.value.trim();
  if (!groupName) {
    alert('Please enter a group name');
    return;
  }

  const members = Array.from(membersList.querySelectorAll('input[type="checkbox"]:checked'))
    .map(checkbox => checkbox.value);

  if (members.length === 0) {
    alert('Please select at least one member');
    return;
  }

  hideGroupModal();
  socket.emit('create_group', {
    name: groupName,
    members: [currentUser.id, ...members]
  });
});

socket.on('group_created', (group) => {
  addChatItem(group.name, group.id, 'group');
});