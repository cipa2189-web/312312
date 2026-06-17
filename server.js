const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// username -> socket.id
const users = new Map();
// socket.id -> username
const sockets = new Map();

// groupName -> { name, owner, admins: Set<string>, members: Set<string> }
const groups = new Map();

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'simple-messenger',
    usersOnline: users.size,
    groups: Array.from(groups.keys()).sort()
  });
});

function userList() {
  return Array.from(users.keys()).sort();
}

function groupsForUser(username) {
  return Array.from(groups.values())
    .filter(group => group.members.has(username))
    .map(group => ({
      name: group.name,
      owner: group.owner,
      admins: Array.from(group.admins || new Set([group.owner])).sort(),
      members: Array.from(group.members).sort()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isValidName(value) {
  return /^[a-zA-Zа-яА-ЯёЁ0-9_\-. ]+$/.test(value);
}

function broadcastUsers() {
  io.emit('users', userList());
}

function emitGroupsTo(username) {
  const socketId = users.get(username);
  if (socketId) {
    io.to(socketId).emit('groups', groupsForUser(username));
  }
}

function broadcastGroupsToAllOnline() {
  for (const username of users.keys()) emitGroupsTo(username);
}

function joinUserToGroupRoom(username, groupName) {
  const socketId = users.get(username);
  const socket = socketId ? io.sockets.sockets.get(socketId) : null;
  if (socket) socket.join('group:' + groupName);
}


function isGroupOwner(group, username) {
  return group && group.owner === username;
}

function sendGroupSystemMessage(groupName, text) {
  const systemMessage = {
    type: 'group',
    group: groupName,
    from: 'Система',
    text,
    time: Date.now()
  };
  io.to('group:' + groupName).emit('group_message', systemMessage);
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  socket.on('login', (rawUsername, callback) => {
    const username = String(rawUsername || '').trim();

    if (!username || username.length < 2 || username.length > 20) {
      return callback && callback({ ok: false, error: 'Имя должно быть от 2 до 20 символов' });
    }
    if (!isValidName(username)) {
      return callback && callback({ ok: false, error: 'Можно использовать буквы, цифры, _, -, . и пробел' });
    }
    if (users.has(username)) {
      return callback && callback({ ok: false, error: 'Такой пользователь уже онлайн' });
    }

    users.set(username, socket.id);
    sockets.set(socket.id, username);
    socket.data.username = username;

    // Подключаем пользователя к комнатам его групп.
    for (const group of groups.values()) {
      if (group.members.has(username)) socket.join('group:' + group.name);
    }

    callback && callback({
      ok: true,
      username,
      users: userList(),
      groups: groupsForUser(username)
    });

    broadcastUsers();
    emitGroupsTo(username);
    console.log('login', username);
  });

  socket.on('create_group', (rawName, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const name = String(rawName || '').trim();
    if (!name || name.length < 2 || name.length > 30) {
      return callback && callback({ ok: false, error: 'Название группы должно быть от 2 до 30 символов' });
    }
    if (!isValidName(name)) {
      return callback && callback({ ok: false, error: 'Можно использовать буквы, цифры, _, -, . и пробел' });
    }
    if (groups.has(name)) {
      return callback && callback({ ok: false, error: 'Такая группа уже есть' });
    }

    groups.set(name, {
      name,
      owner: username,
      admins: new Set([username]),
      members: new Set([username])
    });

    socket.join('group:' + name);
    emitGroupsTo(username);
    callback && callback({ ok: true, group: name });
    console.log('create_group', name, 'owner', username);
  });

  socket.on('add_user_to_group', (payload, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const groupName = String(payload?.group || '').trim();
    const userToAdd = String(payload?.user || '').trim();
    const group = groups.get(groupName);

    if (!group) {
      return callback && callback({ ok: false, error: 'Такой группы нет' });
    }
    if (!isGroupOwner(group, username)) {
      return callback && callback({ ok: false, error: 'Добавлять людей может только создатель группы' });
    }
    if (!users.has(userToAdd)) {
      return callback && callback({ ok: false, error: 'Пользователь не онлайн' });
    }
    if (group.members.has(userToAdd)) {
      return callback && callback({ ok: false, error: 'Пользователь уже в группе' });
    }

    group.members.add(userToAdd);
    joinUserToGroupRoom(userToAdd, groupName);

    emitGroupsTo(userToAdd);
    emitGroupsTo(username);

    sendGroupSystemMessage(groupName, `${username} добавил ${userToAdd} в группу`);

    callback && callback({ ok: true, group: groupName, user: userToAdd });
    console.log('add_user_to_group', userToAdd, 'to', groupName, 'by', username);
  });

  socket.on('leave_group', (payload, callback) => {
    const username = socket.data.username;
    if (!username) return callback && callback({ ok: false, error: 'Сначала выполните вход' });

    const groupName = String(payload?.group || '').trim();
    const group = groups.get(groupName);
    if (!group) return callback && callback({ ok: false, error: 'Такой группы нет' });
    if (!group.members.has(username)) return callback && callback({ ok: false, error: 'Вы не участник группы' });
    if (group.owner === username) return callback && callback({ ok: false, error: 'Создатель не может выйти. Можно удалить группу.' });

    group.members.delete(username);
    group.admins && group.admins.delete(username);
    socket.leave('group:' + groupName);
    emitGroupsTo(username);
    for (const member of group.members) emitGroupsTo(member);
    sendGroupSystemMessage(groupName, `${username} вышел из группы`);
    callback && callback({ ok: true });
  });

  socket.on('delete_group', (payload, callback) => {
    const username = socket.data.username;
    if (!username) return callback && callback({ ok: false, error: 'Сначала выполните вход' });

    const groupName = String(payload?.group || '').trim();
    const group = groups.get(groupName);
    if (!group) return callback && callback({ ok: false, error: 'Такой группы нет' });
    if (!isGroupOwner(group, username)) return callback && callback({ ok: false, error: 'Удалить группу может только создатель' });

    const members = Array.from(group.members);
    io.to('group:' + groupName).emit('group_deleted', { group: groupName });
    groups.delete(groupName);
    for (const member of members) emitGroupsTo(member);
    callback && callback({ ok: true });
  });

  socket.on('remove_user_from_group', (payload, callback) => {
    const username = socket.data.username;
    if (!username) return callback && callback({ ok: false, error: 'Сначала выполните вход' });

    const groupName = String(payload?.group || '').trim();
    const userToRemove = String(payload?.user || '').trim();
    const group = groups.get(groupName);
    if (!group) return callback && callback({ ok: false, error: 'Такой группы нет' });
    if (!isGroupOwner(group, username)) return callback && callback({ ok: false, error: 'Удалять участников может только создатель' });
    if (userToRemove === group.owner) return callback && callback({ ok: false, error: 'Нельзя удалить создателя группы' });
    if (!group.members.has(userToRemove)) return callback && callback({ ok: false, error: 'Пользователь не в группе' });

    group.members.delete(userToRemove);
    group.admins && group.admins.delete(userToRemove);
    const socketId = users.get(userToRemove);
    const targetSocket = socketId ? io.sockets.sockets.get(socketId) : null;
    if (targetSocket) targetSocket.leave('group:' + groupName);

    emitGroupsTo(userToRemove);
    for (const member of group.members) emitGroupsTo(member);
    sendGroupSystemMessage(groupName, `${username} удалил ${userToRemove} из группы`);
    callback && callback({ ok: true });
  });

  socket.on('set_group_admin', (payload, callback) => {
    const username = socket.data.username;
    if (!username) return callback && callback({ ok: false, error: 'Сначала выполните вход' });

    const groupName = String(payload?.group || '').trim();
    const targetUser = String(payload?.user || '').trim();
    const isAdmin = payload?.admin !== false;
    const group = groups.get(groupName);
    if (!group) return callback && callback({ ok: false, error: 'Такой группы нет' });
    if (!isGroupOwner(group, username)) return callback && callback({ ok: false, error: 'Назначать админов может только создатель' });
    if (!group.members.has(targetUser)) return callback && callback({ ok: false, error: 'Пользователь не в группе' });
    if (targetUser === group.owner && !isAdmin) return callback && callback({ ok: false, error: 'Создатель всегда админ' });

    if (!group.admins) group.admins = new Set([group.owner]);
    if (isAdmin) group.admins.add(targetUser);
    else group.admins.delete(targetUser);

    for (const member of group.members) emitGroupsTo(member);
    sendGroupSystemMessage(groupName, isAdmin ? `${targetUser} теперь администратор` : `${targetUser} больше не администратор`);
    callback && callback({ ok: true });
  });

  socket.on('private_message', (payload, callback) => {
    const from = socket.data.username;
    if (!from) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const to = String(payload?.to || '').trim();
    const text = String(payload?.text || '').trim();

    if (!to || !users.has(to)) {
      return callback && callback({ ok: false, error: 'Получатель не онлайн' });
    }
    if (!text || text.length > 1000) {
      return callback && callback({ ok: false, error: 'Сообщение пустое или слишком длинное' });
    }

    const message = { type: 'private', from, to, text, time: Date.now() };

    io.to(users.get(to)).emit('private_message', message);
    socket.emit('private_message', message);
    callback && callback({ ok: true });
  });

  socket.on('group_message', (payload, callback) => {
    const from = socket.data.username;
    if (!from) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const groupName = String(payload?.group || '').trim();
    const text = String(payload?.text || '').trim();
    const group = groups.get(groupName);

    if (!group) {
      return callback && callback({ ok: false, error: 'Такой группы нет' });
    }
    if (!group.members.has(from)) {
      return callback && callback({ ok: false, error: 'Вы не участник этой группы' });
    }
    if (!text || text.length > 1000) {
      return callback && callback({ ok: false, error: 'Сообщение пустое или слишком длинное' });
    }

    const message = { type: 'group', group: groupName, from, text, time: Date.now() };
    io.to('group:' + groupName).emit('group_message', message);
    callback && callback({ ok: true });
  });

  socket.on('disconnect', () => {
    const username = sockets.get(socket.id);
    if (username) {
      users.delete(username);
      sockets.delete(socket.id);
      broadcastUsers();
      broadcastGroupsToAllOnline();
      console.log('logout', username);
    }
    console.log('disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
