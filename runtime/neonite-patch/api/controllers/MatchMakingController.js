const crypto = require('crypto');
const { ApiException } = require('../../structs/errors');
const errors = require('../../structs/errors');
const NeoLog = require('../../structs/NeoLog');

const GAME_HOST = process.env.VAULTED_GAME_HOST || '127.0.0.1';
const GAME_PORT = Number(process.env.VAULTED_GAME_PORT || 7777);
const MATCHMAKER_URL = process.env.VAULTED_MATCHMAKER_URL || 'ws://127.0.0.1:3552';
let currentBuildUniqueId = '0';
let currentPlaylist = 'playlist_defaultsolo';

function randomId() {
  return crypto.randomBytes(16).toString('hex');
}

function parseBucket(bucketId) {
  const parts = String(bucketId || '').split(':');
  return {
    netcl: parts[0] || '',
    hotfix: parts[1] || '0',
    region: parts[2] || 'NAE',
    playlist: parts[3] || 'playlist_defaultsolo',
  };
}

function playlistName(playlist) {
  const value = String(playlist || 'playlist_defaultsolo').trim();
  if (!value) return 'Playlist_DefaultSolo';
  const name = value.replace(/^playlist_/i, '');
  const known = {
    defaultsolo: 'DefaultSolo',
    defaultduo: 'DefaultDuo',
    defaultsquad: 'DefaultSquad',
    playgroundv2: 'PlaygroundV2',
    creative: 'Creative',
    showdown: 'Showdown',
  };
  return `Playlist_${known[name.toLowerCase()] || name}`;
}

module.exports = {
  matchmakingTicket: function (req, res) {
    const bucket = parseBucket(req.query.bucketId);
    if (!bucket.netcl || !bucket.region || !bucket.playlist) {
      throw new ApiException(errors.com.epicgames.fortnite.invalid_bucket_id)
        .withMessage(`Failed to parse bucketId: '${req.query.bucketId}'`)
        .with(req.query.bucketId);
    }

    currentBuildUniqueId = bucket.netcl;
    currentPlaylist = bucket.playlist;
    res.cookie('NetCL', bucket.netcl);
    res.cookie('currentbuildUniqueId', bucket.netcl);
    res.cookie('currentPlaylist', bucket.playlist);

    const data = {
      playerId: req.params.accountId,
      partyPlayerIds: [req.params.accountId],
      bucketId: `FN:Live:${bucket.netcl}:${bucket.hotfix}:${bucket.region}:${bucket.playlist}:PC:public:1`,
      attributes: {
        'player.userAgent': req.headers['user-agent'],
        'player.preferredSubregion': 'None',
        'player.option.spectator': 'false',
        'player.inputTypes': '',
        'playlist.revision': '1',
        'player.teamFormat': 'fun',
      },
      expireAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      nonce: randomId(),
    };

    Object.entries(req.query).forEach(([key, value]) => {
      if (key === 'player.subregions' && String(value).includes(',')) {
        data.attributes['player.preferredSubregion'] = String(value).split(',')[0];
      }
      data.attributes[key] = value;
    });

    NeoLog.Log(`Matchmaking into ${bucket.playlist} (${bucket.region})`);
    res.json({
      serviceUrl: MATCHMAKER_URL,
      ticketType: 'mms-player',
      payload: Buffer.from(JSON.stringify(data)).toString('base64'),
      signature: 'account',
    });
  },

  matchmakingSession: function (req, res) {
    res.json({
      accountId: req.params.accountId,
      sessionId: req.params.sessionId,
      key: 'none',
    });
  },

  matchmakingSessionConfirm: function (req, res) {
    res.json({
      accountId: req.params.accountId,
      sessionId: req.params.sessionId,
      key: req.body?.key || 'none',
    });
  },

  matchmakingSession2: function (req, res) {
    const playlist = req.cookies?.currentPlaylist || currentPlaylist || 'playlist_defaultsolo';
    const buildUniqueId = req.cookies?.currentbuildUniqueId || req.cookies?.NetCL || currentBuildUniqueId || '0';
    const sessionId = req.params.sessionId;
    const ownerId = randomId().toUpperCase();
    const serverAddress = `${GAME_HOST}:${GAME_PORT}`;

    res.json({
      id: sessionId,
      ownerId,
      ownerName: '[DS]fortnite-liveeugcec1c2e30ubrcore0a-z8hj-1968',
      serverName: '[DS]fortnite-liveeugcec1c2e30ubrcore0a-z8hj-1968',
      serverAddress: GAME_HOST,
      serverPort: GAME_PORT,
      maxPublicPlayers: 220,
      openPublicPlayers: 175,
      maxPrivatePlayers: 0,
      openPrivatePlayers: 0,
      attributes: {
        REGION_s: 'NAE',
        GAMEMODE_s: 'FORTATHENA',
        ALLOWBROADCASTING_b: true,
        SUBREGION_s: 'GB',
        DCID_s: 'FORTNITE-LIVEEUGCEC1C2E30UBRCORE0A-14840880',
        tenant_s: 'Fortnite',
        MATCHMAKINGPOOL_s: 'Any',
        STORMSHIELDDEFENSETYPE_i: 0,
        HOTFIXVERSION_i: 0,
        PLAYLISTNAME_s: playlistName(playlist),
        SESSIONKEY_s: randomId().toUpperCase(),
        TENANT_s: 'Fortnite',
        BEACONPORT_i: 15009,
        ALLOWMIGRATION_s: 'false',
        REJOINAFTERKICK_s: 'OPEN',
        CHECKSANCTIONS_s: 'false',
        BUCKET_s: buildUniqueId,
        DEPLOYMENT_s: 'Fortnite',
        LASTUPDATED_s: new Date().toISOString(),
        LINKID_s: `${playlist}?v=95`,
        allowMigration_s: false,
        ALLOWREADBYID_s: 'false',
        SERVERADDRESS_s: serverAddress,
        NETWORKMODULE_b: true,
        lastUpdated_s: new Date().toISOString(),
        allowReadById_s: false,
        serverAddress_s: serverAddress,
        LINKTYPE_s: 'BR:Playlist',
        deployment_s: 'Fortnite',
        ADDRESS_s: serverAddress,
        bucket_s: buildUniqueId,
        checkSanctions_s: false,
        rejoinAfterKick_s: 'OPEN',
      },
      publicPlayers: [],
      privatePlayers: [],
      totalPlayers: 45,
      allowJoinInProgress: false,
      shouldAdvertise: false,
      isDedicated: false,
      usesStats: false,
      allowInvites: false,
      usesPresence: false,
      allowJoinViaPresence: true,
      allowJoinViaPresenceFriendsOnly: false,
      buildUniqueId,
      lastUpdated: new Date().toISOString(),
      started: false,
    });
  },

  findPlayer: function (_req, res) {
    res.json([]);
  },

  verifyMatch: function (req, res) {
    res.json({
      account_id: req.body.account_id,
      data: req.body.data,
      allow: true,
    });
  },

  EosMatchmakingJoin: function (req, res) {
    res.json({
      ticketId: req.query.ticketId,
      sessionId: randomId(),
      serviceUrl: MATCHMAKER_URL,
    });
  },

  EosMatchmakingHeartbeat: function (_req, res) {
    res.json({
      ticketState: 'MATCHMAKING',
      terminalStateDetail: null,
    });
  },
};
