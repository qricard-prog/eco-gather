// Couche média LiveKit — Étape 3.
// - Connexion à une room LiveKit unique (l'« espace »), autoSubscribe désactivé.
// - On publie son micro + sa caméra ; on ne SOUSCRIT qu'aux participants proches
//   (piloté par la proximité, via subscribeTo / unsubscribeFrom).
// - Rendu : vignettes vidéo (DOM) au-dessus du canvas + barre de contrôles.
//
// L'identité LiveKit d'un participant = son id Socket.io → même clé que la map
// `others` de GameScene, ce qui permet de relier proximité et flux média.

import { Room, RoomEvent, Track } from 'livekit-client';

export class LiveKitMedia {
  constructor() {
    this.room = null;
    this.connected = false;
    this.connecting = false;
    this.nearby = new Set(); // identités proches (à garder souscrites)
    this.tileMap = new Map(); // tileId -> { tile, video }
    this.audioMap = new Map(); // track.sid -> element

    this.layer = document.getElementById('media');
    this.tilesEl = document.getElementById('tiles');
    this.audioSink = document.getElementById('audio-sink');
    this.backdrop = document.getElementById('screen-backdrop');
    this.backdrop?.addEventListener('click', () => this.minimizeScreens());
    this.setupControls();
  }

  async connect(url, token, pseudo) {
    if (this.connected || this.connecting) return;
    this.connecting = true;
    this.pseudo = pseudo;
    this.room = new Room({ adaptiveStream: true, dynacast: true });

    this.room
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => this.onTrackSubscribed(track, p))
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => this.onTrackUnsubscribed(track, p))
      .on(RoomEvent.TrackPublished, (pub, p) => {
        // Un participant proche publie un nouveau flux (ex : il allume sa caméra)
        if (this.nearby.has(p.identity)) pub.setSubscribed(true);
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        if (this.nearby.has(p.identity)) this.subscribeTo(p.identity);
      })
      .on(RoomEvent.LocalTrackPublished, (pub) => this.onLocalTrackPublished(pub))
      .on(RoomEvent.LocalTrackUnpublished, (pub) => this.onLocalTrackUnpublished(pub))
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => this.onActiveSpeakers(speakers))
      .on(RoomEvent.Disconnected, () => {
        this.connected = false;
      });

    try {
      await this.room.connect(url, token, { autoSubscribe: false });
    } catch (e) {
      this.connecting = false;
      this.room = null;
      throw e;
    }
    this.connected = true;
    this.connecting = false;
    this.layer.classList.remove('hidden');

    // Publie micro + caméra par défaut (la 1re fois déclenche la demande de permission).
    try {
      await this.room.localParticipant.setMicrophoneEnabled(true);
      await this.room.localParticipant.setCameraEnabled(true);
    } catch (e) {
      console.warn('[media] micro/caméra indisponibles :', e?.message || e);
    }
    this.refreshControls();

    // Souscrit aux participants déjà désirés (proximité enregistrée avant la connexion).
    this.nearby.forEach((id) => {
      const p = this.room.remoteParticipants.get(id);
      if (p) p.trackPublications.forEach((pub) => pub.setSubscribed(true));
    });
  }

  // ----- Proximité : on (dé)souscrit aux flux des avatars proches -----

  subscribeTo(identity) {
    this.nearby.add(identity);
    const p = this.room?.remoteParticipants.get(identity);
    if (p) p.trackPublications.forEach((pub) => pub.setSubscribed(true));
  }

  unsubscribeFrom(identity) {
    this.nearby.delete(identity);
    const p = this.room?.remoteParticipants.get(identity);
    if (p) p.trackPublications.forEach((pub) => pub.setSubscribed(false));
  }

  // ----- Réception des flux distants -----

  onTrackSubscribed(track, participant) {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.dataset.sid = track.sid;
      this.audioSink.appendChild(el);
      this.audioMap.set(track.sid, el);
      return;
    }
    if (track.kind === Track.Kind.Video) {
      const isScreen = track.source === Track.Source.ScreenShare;
      const id = `${isScreen ? 'scr' : 'vid'}:${participant.identity}`;
      const label = `${participant.name || participant.identity}${isScreen ? ' · écran' : ''}`;
      const video = this.ensureTile(id, label, { screen: isScreen, identity: participant.identity });
      track.attach(video);
    }
  }

  onTrackUnsubscribed(track, participant) {
    if (track.kind === Track.Kind.Audio) {
      const el = this.audioMap.get(track.sid);
      if (el) {
        track.detach(el);
        el.remove();
        this.audioMap.delete(track.sid);
      }
      return;
    }
    const isScreen = track.source === Track.Source.ScreenShare;
    this.removeTile(`${isScreen ? 'scr' : 'vid'}:${participant.identity}`);
  }

  // ----- Mes propres flux (self view) -----

  onLocalTrackPublished(pub) {
    const track = pub.track;
    if (!track || track.kind !== Track.Kind.Video) return;
    const isScreen = track.source === Track.Source.ScreenShare;
    const id = isScreen ? 'self:scr' : 'self:cam';
    const video = this.ensureTile(id, `${this.pseudo} (moi)${isScreen ? ' · écran' : ''}`, {
      self: true,
      screen: isScreen,
    });
    track.attach(video);
  }

  onLocalTrackUnpublished(pub) {
    if (pub.track?.kind !== Track.Kind.Video) return;
    const isScreen = pub.track.source === Track.Source.ScreenShare;
    this.removeTile(isScreen ? 'self:scr' : 'self:cam');
  }

  onActiveSpeakers(speakers) {
    const active = new Set(speakers.map((s) => s.identity));
    this.tileMap.forEach(({ tile }, id) => {
      const identity = tile.dataset.identity;
      const isSelf = id.startsWith('self:');
      const speaking = isSelf
        ? speakers.some((s) => s.isLocal)
        : identity && active.has(identity);
      tile.classList.toggle('speaking', Boolean(speaking));
    });
  }

  // ----- Tuiles vidéo (DOM) -----

  ensureTile(id, label, opts = {}) {
    let entry = this.tileMap.get(id);
    if (entry) return entry.video;

    const tile = document.createElement('div');
    tile.className = 'tile' + (opts.screen ? ' screen' : '') + (opts.self ? ' self' : '');
    if (opts.identity) tile.dataset.identity = opts.identity;
    // Un partage d'écran est cliquable pour s'agrandir / se réduire.
    if (opts.screen) {
      tile.title = 'Cliquer pour agrandir / réduire';
      tile.addEventListener('click', () => this.toggleMaximize(tile));
    }

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (opts.self) video.muted = true; // pas de larsen sur sa propre vidéo

    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = label;

    tile.append(video, name);
    this.tilesEl.appendChild(tile);
    entry = { tile, video };
    this.tileMap.set(id, entry);
    return video;
  }

  removeTile(id) {
    const entry = this.tileMap.get(id);
    if (!entry) return;
    if (entry.tile.classList.contains('maximized')) this.minimizeScreens();
    entry.video.srcObject = null;
    entry.tile.remove();
    this.tileMap.delete(id);
  }

  // Agrandit / réduit une vignette de partage d'écran (un seul agrandi à la fois).
  toggleMaximize(tile) {
    const willMax = !tile.classList.contains('maximized');
    this.minimizeScreens();
    if (willMax) {
      tile.classList.add('maximized');
      this.backdrop?.classList.remove('hidden');
    }
  }

  minimizeScreens() {
    this.tilesEl.querySelectorAll('.tile.maximized').forEach((t) => t.classList.remove('maximized'));
    this.backdrop?.classList.add('hidden');
  }

  // ----- Barre de contrôles -----

  setupControls() {
    this.btnMic = document.getElementById('btn-mic');
    this.btnCam = document.getElementById('btn-cam');
    this.btnScreen = document.getElementById('btn-screen');

    this.btnMic?.addEventListener('click', () => this.toggleMic());
    this.btnCam?.addEventListener('click', () => this.toggleCam());
    this.btnScreen?.addEventListener('click', () => this.toggleScreen());
  }

  async toggleMic() {
    if (!this.connected) return;
    const lp = this.room.localParticipant;
    await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
    this.refreshControls();
  }

  async toggleCam() {
    if (!this.connected) return;
    const lp = this.room.localParticipant;
    await lp.setCameraEnabled(!lp.isCameraEnabled);
    this.refreshControls();
  }

  async toggleScreen() {
    if (!this.connected) return;
    const lp = this.room.localParticipant;
    try {
      await lp.setScreenShareEnabled(!lp.isScreenShareEnabled);
    } catch (e) {
      console.warn('[media] partage d\'écran annulé :', e?.message || e);
    }
    this.refreshControls();
  }

  refreshControls() {
    if (!this.room) return;
    const lp = this.room.localParticipant;
    this.btnMic?.classList.toggle('off', !lp.isMicrophoneEnabled);
    this.btnMic && (this.btnMic.textContent = lp.isMicrophoneEnabled ? '🎤' : '🔇');
    this.btnCam?.classList.toggle('off', !lp.isCameraEnabled);
    this.btnCam && (this.btnCam.textContent = lp.isCameraEnabled ? '🎥' : '🚫');
    this.btnScreen?.classList.toggle('active', lp.isScreenShareEnabled);
  }

  // Quitte la room LiveKit (stop la consommation de minutes) et nettoie l'UI.
  // Garde l'instance réutilisable : une nouvelle proximité reconnectera.
  disconnect() {
    this.minimizeScreens();
    [...this.tileMap.keys()].forEach((id) => this.removeTile(id));
    this.audioMap.forEach((el) => el.remove());
    this.audioMap.clear();
    this.room?.disconnect();
    this.room = null;
    this.connected = false;
    this.connecting = false;
    this.layer?.classList.add('hidden');
  }
}
