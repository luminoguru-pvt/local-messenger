const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { createServer } = require('http');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

let mainWindow;
let io;
let db;

// Initialize SQLite database
function initDatabase() {
  db = new sqlite3.Database('messenger.db', (err) => {
    if (err) console.error('Database opening error: ', err);
  });

  db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      employee_id TEXT UNIQUE,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Messages table
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT,
      receiver_id TEXT,
      content TEXT,
      type TEXT,
      group_id TEXT,
      status TEXT DEFAULT 'pending',
      delivered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users (id)
    )`);

    // Groups table
    db.run(`CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Group members table
    db.run(`CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT,
      user_id TEXT,
      FOREIGN KEY (group_id) REFERENCES groups (id),
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
  });
}

// Initialize Express and Socket.IO server
function initServer() {
  const expressApp = express();
  const httpServer = createServer(expressApp);
  io = new Server(httpServer, {
    cors: {
      origin: '*',
    }
  });

  io.on('connection', (socket) => {
    console.log('New client connected');

    // Handle user authentication
    socket.on('authenticate', (data) => {
      const { employee_id, name } = data;
      const user_id = uuidv4();

      db.run('INSERT OR IGNORE INTO users (id, employee_id, name) VALUES (?, ?, ?)',
        [user_id, employee_id, name],
        (err) => {
          if (err) {
            socket.emit('auth_response', { success: false, error: err.message });
          } else {
            socket.emit('auth_response', { 
              success: true, 
              user_id,
              employee_id,
              name
            });
          }
        });
    });

    // Handle direct messages
    socket.on('direct_message', (data) => {
      const messageId = uuidv4();
      const { sender_id, receiver_id, content, type } = data;
      const status = 'pending';

      db.run('INSERT INTO messages (id, sender_id, receiver_id, content, type, status) VALUES (?, ?, ?, ?, ?, ?)',
        [messageId, sender_id, receiver_id, content, type, status],
        (err) => {
          if (!err) {
            io.emit('new_message', { ...data, id: messageId, status });
          }
        });
    });

    // Handle get chat history
    socket.on('get_chat_history', (data) => {
      const { user_id, chat_id, chat_type } = data;
      
      if (chat_type === 'user') {
        db.all(
          'SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY created_at ASC',
          [user_id, chat_id, chat_id, user_id],
          (err, messages) => {
            if (!err) {
              socket.emit('chat_history', messages);
            }
          }
        );
      } else if (chat_type === 'group') {
        db.all(
          'SELECT * FROM messages WHERE group_id = ? ORDER BY created_at ASC',
          [chat_id],
          (err, messages) => {
            if (!err) {
              socket.emit('chat_history', messages);
            }
          }
        );
      }
    });

    // Handle message delivery status
    socket.on('message_delivered', (data) => {
      const { message_id } = data;
      
      db.run(
        'UPDATE messages SET status = ?, delivered_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['delivered', message_id],
        (err) => {
          if (!err) {
            io.emit('message_status_updated', { message_id, status: 'delivered' });
          }
        }
      );
    });

    // Handle group messages
    socket.on('group_message', (data) => {
      const messageId = uuidv4();
      const { sender_id, group_id, content, type } = data;
      const status = 'pending';

      db.run('INSERT INTO messages (id, sender_id, group_id, content, type, status) VALUES (?, ?, ?, ?, ?, ?)',
        [messageId, sender_id, group_id, content, type, status],
        (err) => {
          if (!err) {
            io.emit('new_group_message', { ...data, id: messageId, status });
          }
        });
    });

    // Handle user online status
    socket.on('user_online', (data) => {
      const { user_id } = data;
      
      // Deliver pending messages to the user
      db.all(
        'SELECT * FROM messages WHERE receiver_id = ? AND status = "pending" ORDER BY created_at ASC',
        [user_id],
        (err, messages) => {
          if (!err && messages.length > 0) {
            messages.forEach(message => {
              socket.emit('new_message', message);
            });
          }
        }
      );

      // Deliver pending group messages
      db.all(
        'SELECT m.* FROM messages m JOIN group_members gm ON m.group_id = gm.group_id WHERE gm.user_id = ? AND m.status = "pending" ORDER BY m.created_at ASC',
        [user_id],
        (err, messages) => {
          if (!err && messages.length > 0) {
            messages.forEach(message => {
              socket.emit('new_group_message', message);
            });
          }
        }
      );
    });

    // Handle group creation
    socket.on('create_group', (data) => {
      const group_id = uuidv4();
      const { name, members } = data;

      db.run('INSERT INTO groups (id, name) VALUES (?, ?)',
        [group_id, name],
        (err) => {
          if (!err) {
            members.forEach(member_id => {
              db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)',
                [group_id, member_id]);
            });
            io.emit('group_created', { id: group_id, name, members });
          }
        });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });

  httpServer.listen(3000, () => {
    console.log('Server running on port 3000');
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: true
    }
  });

  // Open DevTools by default in development
  mainWindow.webContents.openDevTools();

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  initDatabase();
  initServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  db.close();
});
