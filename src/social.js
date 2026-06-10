// Couche sociale : chat texte + émotes (via Socket.io, sans LiveKit).
// Gère le DOM (panneau de chat, barre d'émotes) ; GameScene fait le lien
// avec le réseau et affiche les bulles / émojis flottants dans le monde.

// Doit rester synchro avec la liste côté serveur (server/index.js).
export const EMOTES = ['👋', '👍', '🎉', '❤️', '😂', '🤔'];

const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');

export class Social {
  constructor({ onSendChat, onEmote, onFocusChange }) {
    this.onSendChat = onSendChat;
    this.onEmote = onEmote;
    this.onFocusChange = onFocusChange;

    this.root = document.getElementById('social');
    this.log = document.getElementById('chat-log');
    this.input = document.getElementById('chat-input');
    this.emoteBar = document.getElementById('emote-bar');

    this.root?.classList.remove('hidden');
    this.buildEmotes();
    this.wireInput();
  }

  buildEmotes() {
    EMOTES.forEach((emoji, i) => {
      const b = document.createElement('button');
      b.textContent = emoji;
      b.title = `Réagir ${emoji} (touche ${i + 1})`;
      b.addEventListener('click', () => this.onEmote?.(emoji));
      this.emoteBar.appendChild(b);
    });
  }

  wireInput() {
    this.input.addEventListener('focus', () => this.onFocusChange?.(true));
    this.input.addEventListener('blur', () => this.onFocusChange?.(false));
    this.input.addEventListener('keydown', (e) => {
      // Empêche les touches saisies de piloter le jeu (Phaser écoute window).
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = this.input.value.trim();
        if (t) {
          this.onSendChat?.(t);
          this.input.value = '';
        }
      } else if (e.key === 'Escape') {
        this.input.blur();
      }
    });
  }

  focusInput() {
    this.input.focus();
  }

  // Ajoute une ligne au journal de chat (nom coloré + texte).
  addMessage({ name, color, text, self }) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const n = document.createElement('span');
    n.className = 'chat-name';
    n.style.color = hex(color);
    n.textContent = `${self ? name + ' (moi)' : name} : `;
    div.append(n, document.createTextNode(text));
    this.log.appendChild(div);
    while (this.log.children.length > 60) this.log.removeChild(this.log.firstChild);
    this.log.scrollTop = this.log.scrollHeight;
  }
}
