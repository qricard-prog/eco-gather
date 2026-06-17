// Petits sons générés à la volée (Web Audio) — aucun fichier asset.

let ctx;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx?.state === 'suspended') ctx.resume();
  return ctx;
}

// À appeler sur un geste utilisateur (clic « Entrer ») pour débloquer l'audio.
export function unlockAudio() {
  audio();
}

// Petit « blip » montant, joué quand quelqu'un entre en conversation.
export function playJoinChime() {
  const a = audio();
  if (!a) return;
  const now = a.currentTime;
  [660, 990].forEach((freq, i) => {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t0 = now + i * 0.085;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.11, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    osc.connect(gain).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + 0.22);
  });
}
