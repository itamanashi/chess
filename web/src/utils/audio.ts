// Synthétiseur d'effets sonores d'échecs via Web Audio API
// 100% autonome, zéro dépendance réseau, zéro temps de latence

class ChessAudio {
  private ctx: AudioContext | null = null;
  private soundEnabled: boolean = true;
  // Sample « move » standard de Lichess (lila, GPL-3.0), vendu dans
  // `public/sounds/move.mp3`. Zéro réseau externe, repli synthé si échec.
  private moveSample: HTMLAudioElement | null = null;
  private moveSampleFailed = false;

  constructor() {
    // Initialisation paresseuse au premier clic utilisateur (requis par les navigateurs)
  }

  private getContext(): AudioContext | null {
    if (!this.soundEnabled) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public setSoundEnabled(enabled: boolean) {
    this.soundEnabled = enabled;
  }

  public isSoundEnabled(): boolean {
    return this.soundEnabled;
  }

  private getMoveSample(): HTMLAudioElement | null {
    if (!this.soundEnabled || this.moveSampleFailed) return null;
    if (!this.moveSample) {
      const el = new Audio('/sounds/move.mp3');
      el.preload = 'auto';
      el.addEventListener('error', () => {
        this.moveSampleFailed = true;
      });
      this.moveSample = el;
    }
    return this.moveSample;
  }

  // Son de déplacement : sample Lichess, repli sur la synthèse locale.
  public playMove() {
    const sample = this.getMoveSample();
    if (sample) {
      sample.currentTime = 0;
      const started = sample.play();
      if (started) {
        started.catch(() => this.playMoveSynth());
        return;
      }
    }
    this.playMoveSynth();
  }

  // Ancienne synthèse locale (bruit d'impact doux) : repli hors-ligne.
  private playMoveSynth() {
    const ctx = this.getContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.08);

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  }

  // Son de capture (impact plus tranchant et sec)
  public playCapture() {
    const ctx = this.getContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(260, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.12);

    gain.gain.setValueAtTime(0.45, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  }

  // Son d'échec au roi (alerte double tonalité vive)
  public playCheck() {
    const ctx = this.getContext();
    if (!ctx) return;

    [440, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const startTime = ctx.currentTime + i * 0.09;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.25, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.14);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.15);
    });
  }

  // Son de succès en entraînement (arpège ascendant gratifiant)
  public playSuccess() {
    const ctx = this.getContext();
    if (!ctx) return;

    const freqs = [523.25, 659.25, 783.99]; // Do, Mi, Sol (C5, E5, G5)
    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const startTime = ctx.currentTime + idx * 0.07;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.2, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.2);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.22);
    });
  }

  // Son d'erreur (tonalité basse douce pour indiquer un coup hors répertoire)
  public playError() {
    const ctx = this.getContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.18);

    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.19);
  }
}

export const soundFx = new ChessAudio();
