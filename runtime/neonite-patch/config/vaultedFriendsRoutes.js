// Served by the private server so every launcher pointed at it shares the list.
module.exports.routes = {
  'OPTIONS /vaulted/friends': 'VaultedFriendsController.preflight',
  'OPTIONS /vaulted/friends/*': 'VaultedFriendsController.preflight',
  'GET /vaulted/friends/:username': 'VaultedFriendsController.summary',
  'POST /vaulted/friends/request': 'VaultedFriendsController.request',
  'POST /vaulted/friends/respond': 'VaultedFriendsController.respond',
  'POST /vaulted/friends/remove': 'VaultedFriendsController.remove',
}
