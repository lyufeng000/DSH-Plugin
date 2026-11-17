/**
 * Client half of the Completion sound bundle.
 *
 * Three registrations:
 *  - `shell.overlay`: a frame-wide monitor of real turn outcomes and DS Bot
 *    work/wait state. Text and tool-step boundaries never trigger sounds.
 *    Subagent child Sessions stay silent.
 *  - `settings.section`: the "Completion sound" page in Settings.
 *  - `settings.section.icon`: its navigation glyph.
 *
 * Every built-in sound is synthesized with Web Audio: no assets, no network,
 * no license to carry.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-completion-sound',
  factory(require) {
    /* LIFECYCLE_CORE */

    const React = require('react');
    const h = React.createElement;

    const NS = 'completion-sound';
    const STORAGE_KEY = 'dsh.completion-sound.v1';
    /** Queue distinct Bot outcomes instead of dropping them in a global cooldown. */
    const SOUND_GAP_MS = 1800;
    /** A picked local file becomes a data URL; keep the store small. */
    const MAX_FILE_BYTES = 2 * 1024 * 1024;

    const GROUPS = [
      { id: 'classic' },
      { id: 'gentle' },
      { id: 'bright' },
      { id: 'fun' },
    ];

    /**
     * Built-in library. A sound is a note list; a note is one envelope plus an
     * optional filter sweep, pitch slide, inharmonic partials, or noise burst.
     */
    const SOUNDS = [
      {
        id: 'chime',
        group: 'classic',
        notes: [
          { f: 880.0, at: 0, dur: 0.55, type: 'sine', gain: 0.42 },
          { f: 1108.73, at: 0.09, dur: 0.55, type: 'sine', gain: 0.4 },
          { f: 1318.51, at: 0.18, dur: 0.9, type: 'sine', gain: 0.38 },
        ],
      },
      {
        id: 'soft',
        group: 'classic',
        notes: [
          { f: 659.25, at: 0, dur: 0.7, type: 'sine', gain: 0.36 },
          { f: 987.77, at: 0.14, dur: 1.1, type: 'sine', gain: 0.3 },
        ],
      },
      {
        id: 'bell',
        group: 'classic',
        notes: [
          {
            f: 1046.5,
            at: 0,
            dur: 1.8,
            type: 'sine',
            gain: 0.3,
            partials: [
              { ratio: 2, gain: 0.1, dur: 1.2 },
              { ratio: 2.72, gain: 0.07, dur: 0.9 },
              { ratio: 4.2, gain: 0.04, dur: 0.6 },
            ],
          },
        ],
      },
      {
        id: 'pop',
        group: 'classic',
        notes: [
          { f: 1200, at: 0, dur: 0.1, type: 'triangle', gain: 0.3 },
          { f: 520, at: 0.02, dur: 0.12, type: 'sine', gain: 0.22 },
        ],
      },
      {
        id: 'success',
        group: 'classic',
        notes: [
          { f: 523.25, at: 0, dur: 0.28, type: 'triangle', gain: 0.3 },
          { f: 659.25, at: 0.12, dur: 0.28, type: 'triangle', gain: 0.3 },
          { f: 783.99, at: 0.24, dur: 0.55, type: 'triangle', gain: 0.3 },
        ],
      },
      {
        id: 'alert',
        group: 'classic',
        notes: [
          { f: 880, at: 0, dur: 0.16, type: 'square', gain: 0.14 },
          { f: 880, at: 0.22, dur: 0.16, type: 'square', gain: 0.14 },
        ],
      },
      {
        id: 'dong',
        group: 'gentle',
        notes: [
          {
            f: 220,
            at: 0,
            dur: 1.3,
            type: 'triangle',
            gain: 0.3,
            partials: [
              { ratio: 1.5, gain: 0.1, dur: 0.9 },
              { ratio: 2.02, gain: 0.06, dur: 0.6 },
            ],
          },
        ],
      },
      {
        id: 'swell',
        group: 'gentle',
        notes: [
          { f: 261.63, at: 0, dur: 1.7, type: 'sine', gain: 0.16, attack: 0.35, filter: { cutoff: 600, to: 3200, q: 0.8 } },
          { f: 329.63, at: 0, dur: 1.7, type: 'sine', gain: 0.14, attack: 0.38, filter: { cutoff: 600, to: 3200, q: 0.8 } },
          { f: 392.0, at: 0, dur: 1.7, type: 'sine', gain: 0.13, attack: 0.4, filter: { cutoff: 600, to: 3200, q: 0.8 } },
          { f: 523.25, at: 0, dur: 1.7, type: 'sine', gain: 0.1, attack: 0.45, filter: { cutoff: 600, to: 3200, q: 0.8 } },
        ],
      },
      {
        id: 'chord',
        group: 'gentle',
        notes: [
          { f: 523.25, at: 0, dur: 1.0, type: 'sine', gain: 0.22 },
          { f: 659.25, at: 0, dur: 1.0, type: 'sine', gain: 0.2 },
          { f: 783.99, at: 0, dur: 1.0, type: 'sine', gain: 0.18 },
        ],
      },
      {
        id: 'echo',
        group: 'gentle',
        notes: [
          { f: 880, at: 0, dur: 0.6, type: 'sine', gain: 0.3 },
          { f: 880, at: 0.22, dur: 0.6, type: 'sine', gain: 0.14 },
          { f: 880, at: 0.44, dur: 0.7, type: 'sine', gain: 0.07 },
        ],
      },
      {
        id: 'marimba',
        group: 'gentle',
        notes: [
          { f: 523.25, at: 0, dur: 0.4, type: 'triangle', gain: 0.3, partials: [{ ratio: 4, gain: 0.06, dur: 0.12 }] },
          { f: 659.25, at: 0.12, dur: 0.4, type: 'triangle', gain: 0.3, partials: [{ ratio: 4, gain: 0.06, dur: 0.12 }] },
          { f: 783.99, at: 0.24, dur: 0.6, type: 'triangle', gain: 0.3, partials: [{ ratio: 4, gain: 0.06, dur: 0.14 }] },
        ],
      },
      {
        id: 'ding',
        group: 'bright',
        notes: [
          { f: 1046.5, at: 0, dur: 1.0, type: 'sine', gain: 0.3, partials: [{ ratio: 2.76, gain: 0.08, dur: 0.5 }] },
        ],
      },
      {
        id: 'gliss',
        group: 'bright',
        notes: [
          { f: 440, at: 0, dur: 0.4, type: 'sine', gain: 0.26, slide: 3.2 },
          { f: 880, at: 0.02, dur: 0.4, type: 'sine', gain: 0.1, slide: 3.2 },
        ],
      },
      {
        id: 'xylophone',
        group: 'bright',
        notes: [
          { f: 783.99, at: 0, dur: 0.22, type: 'triangle', gain: 0.28 },
          { f: 659.25, at: 0.1, dur: 0.22, type: 'triangle', gain: 0.26 },
          { f: 523.25, at: 0.2, dur: 0.35, type: 'triangle', gain: 0.26 },
        ],
      },
      {
        id: 'triplet',
        group: 'bright',
        notes: [
          { f: 783.99, at: 0, dur: 0.18, type: 'triangle', gain: 0.26 },
          { f: 880, at: 0.1, dur: 0.18, type: 'triangle', gain: 0.26 },
          { f: 987.77, at: 0.2, dur: 0.3, type: 'triangle', gain: 0.26 },
        ],
      },
      {
        id: 'finale',
        group: 'bright',
        notes: [
          { f: 392, at: 0, dur: 0.3, type: 'triangle', gain: 0.24 },
          { f: 523.25, at: 0.1, dur: 0.3, type: 'triangle', gain: 0.24 },
          { f: 659.25, at: 0.2, dur: 0.4, type: 'triangle', gain: 0.24 },
          { f: 783.99, at: 0.3, dur: 0.9, type: 'triangle', gain: 0.24 },
        ],
      },
      {
        id: 'coin',
        group: 'bright',
        notes: [
          { f: 987.77, at: 0, dur: 0.09, type: 'square', gain: 0.16 },
          { f: 1318.51, at: 0.07, dur: 0.4, type: 'square', gain: 0.15 },
        ],
      },
      {
        id: 'retro',
        group: 'fun',
        notes: [
          { f: 523.25, at: 0, dur: 0.1, type: 'square', gain: 0.14 },
          { f: 659.25, at: 0.1, dur: 0.1, type: 'square', gain: 0.14 },
          { f: 783.99, at: 0.2, dur: 0.1, type: 'square', gain: 0.14 },
          { f: 1046.5, at: 0.3, dur: 0.28, type: 'square', gain: 0.14 },
        ],
      },
      {
        id: 'retroDown',
        group: 'fun',
        notes: [
          { f: 783.99, at: 0, dur: 0.1, type: 'square', gain: 0.14 },
          { f: 659.25, at: 0.1, dur: 0.1, type: 'square', gain: 0.14 },
          { f: 523.25, at: 0.2, dur: 0.3, type: 'square', gain: 0.14 },
        ],
      },
      {
        id: 'pulse',
        group: 'fun',
        notes: [
          { f: 660, at: 0, dur: 0.12, type: 'sawtooth', gain: 0.14, filter: { cutoff: 2400, to: 700, q: 3 } },
          { f: 990, at: 0.14, dur: 0.2, type: 'sawtooth', gain: 0.12, filter: { cutoff: 2600, to: 900, q: 3 } },
        ],
      },
      {
        id: 'sonar',
        group: 'fun',
        notes: [
          { f: 760, at: 0, dur: 0.9, type: 'sine', gain: 0.26, filter: { type: 'bandpass', cutoff: 900, q: 2 } },
          { f: 760, at: 0.3, dur: 0.9, type: 'sine', gain: 0.1, filter: { type: 'bandpass', cutoff: 900, q: 2 } },
        ],
      },
      {
        id: 'bird',
        group: 'fun',
        notes: [
          { f: 1800, at: 0, dur: 0.12, type: 'sine', gain: 0.2, slide: 1.35 },
          { f: 2300, at: 0.16, dur: 0.1, type: 'sine', gain: 0.18, slide: 0.8 },
        ],
      },
      {
        id: 'waterdrop',
        group: 'fun',
        notes: [
          { f: 1400, at: 0, dur: 0.16, type: 'sine', gain: 0.22, slide: 0.45 },
          { f: 900, at: 0.05, dur: 0.2, type: 'sine', gain: 0.1, slide: 0.6 },
        ],
      },
      {
        id: 'woodblock',
        group: 'fun',
        notes: [
          { f: 420, at: 0, dur: 0.09, type: 'triangle', gain: 0.26, noise: { dur: 0.05, gain: 0.1, cutoff: 1800, q: 1.4 } },
          { f: 560, at: 0.11, dur: 0.09, type: 'triangle', gain: 0.22, noise: { dur: 0.05, gain: 0.08, cutoff: 1800, q: 1.4 } },
        ],
      },
      {
        id: 'pluck',
        group: 'fun',
        notes: [
          { f: 659.25, at: 0, dur: 0.5, type: 'sawtooth', gain: 0.18, filter: { cutoff: 3200, to: 700, q: 1.2 } },
          { f: 987.77, at: 0.08, dur: 0.45, type: 'sawtooth', gain: 0.12, filter: { cutoff: 3200, to: 700, q: 1.2 } },
        ],
      },
      {
        id: 'tick',
        group: 'fun',
        notes: [
          { f: 1500, at: 0, dur: 0.03, type: 'sine', gain: 0.12, noise: { dur: 0.03, gain: 0.08, cutoff: 3200, q: 1 } },
        ],
      },
    ];

    const DICT = {
      zh: {
        'section.label': '完成提示音',
        'page.intro': 'DS Bot 整段工作彻底结束后才提醒；中途回复、工具步骤和等待委派结果保持静音。异常结束与手动中断使用独立音效。',
        'row.enable.title': '启用完成提示音',
        'row.enable.desc': '关闭后不再发出任何声音。',
        'row.enable.aria': '启用完成提示音',
        'row.scope.title': '提醒范围',
        'row.scope.desc': '选择哪些对话完成后提醒。',
        'row.scopeAll': '所有对话',
        'row.scopeCurrent': '仅当前打开的对话',
        'row.sound.title': '工作完成提示音',
        'row.errorSound.title': '异常断开提示音',
        'row.errorSound.desc': '模型或运行异常、工作中连接持续中断时提醒；短暂重连不响。',
        'row.interruptedSound.title': '手动中断提示音',
        'row.interruptedSound.desc': '手动停止 Bot 或群组任务时提醒；内部切换与插话不算手动停止。',
        'row.none': '静音',
        'row.sound.desc': '切换即试听。26 个内置音效，或自定义音频。',
        'row.custom': '自定义音频',
        'row.volume.title': '音量',
        'row.volume.desc': '只影响提示音，不影响系统音量。',
        'row.preview': '试听',
        'row.custom.title': '自定义音频',
        'row.custom.desc': '音频地址，或本地音频文件（≤ 2 MB）。',
        'row.customPlaceholder': 'https://example.com/done.mp3',
        'row.fileLoaded': '已载入本地音频文件',
        'row.pickFile': '选择文件',
        'row.clear': '清除',
        'row.fileTooLarge': '文件超过 2 MB，请改用音频地址。',
        'row.readFailed': '读取音频文件失败。',
        'row.emptyUrl': '请填写音频地址，或选择一个本地音频文件。',
        'group.classic': '经典',
        'group.gentle': '柔和',
        'group.bright': '明亮',
        'group.fun': '科技与趣味',
        'group.custom': '自定义',
        'sound.chime': '清脆三音',
        'sound.soft': '柔和双音',
        'sound.bell': '钟声',
        'sound.pop': '轻点',
        'sound.success': '上行完成音',
        'sound.alert': '双响提醒',
        'sound.dong': '低沉一声',
        'sound.swell': '和弦渐强',
        'sound.chord': '大三和弦',
        'sound.echo': '回音三响',
        'sound.marimba': '马林巴',
        'sound.ding': '单音铃',
        'sound.gliss': '快速滑音',
        'sound.xylophone': '木琴下行',
        'sound.triplet': '三连跳音',
        'sound.finale': '四音收尾',
        'sound.coin': '金币',
        'sound.retro': '8-bit 上行',
        'sound.retroDown': '8-bit 下行',
        'sound.pulse': '科技脉冲',
        'sound.sonar': '声呐',
        'sound.bird': '鸟鸣',
        'sound.waterdrop': '水滴',
        'sound.woodblock': '木鱼双击',
        'sound.pluck': '拨弦',
        'sound.tick': '轻触',
      },
      en: {
        'section.label': 'Completion sound',
        'page.intro': 'Notify only when the entire DS Bot work settles. Intermediate messages, tools and delegated waits stay silent. Errors and manual stops have separate sounds.',
        'row.enable.title': 'Enable completion sound',
        'row.enable.desc': 'When off, no sound plays at all.',
        'row.enable.aria': 'Enable completion sound',
        'row.scope.title': 'Notify for',
        'row.scope.desc': 'Which finished conversations play the sound.',
        'row.scopeAll': 'All conversations',
        'row.scopeCurrent': 'The open conversation only',
        'row.sound.title': 'Work completed',
        'row.errorSound.title': 'Error or disconnect',
        'row.errorSound.desc': 'Notify for failed runs or a sustained connection loss during work.',
        'row.interruptedSound.title': 'Manually stopped',
        'row.interruptedSound.desc': 'Notify for manual stops, not internal steering or part switches.',
        'row.none': 'Silent',
        'row.sound.desc': 'Changing the selection previews it. 26 built-in effects, or your own audio.',
        'row.custom': 'Custom audio',
        'row.volume.title': 'Volume',
        'row.volume.desc': 'Applies to the notification only, not to system volume.',
        'row.preview': 'Preview',
        'row.custom.title': 'Custom audio',
        'row.custom.desc': 'An audio URL, or a local audio file (2 MB or smaller).',
        'row.customPlaceholder': 'https://example.com/done.mp3',
        'row.fileLoaded': 'Local audio file loaded',
        'row.pickFile': 'Choose file',
        'row.clear': 'Clear',
        'row.fileTooLarge': 'The file exceeds 2 MB. Use an audio URL instead.',
        'row.readFailed': 'The audio file could not be read.',
        'row.emptyUrl': 'Enter an audio URL or choose a local audio file.',
        'group.classic': 'Classic',
        'group.gentle': 'Gentle',
        'group.bright': 'Bright',
        'group.fun': 'Tech and fun',
        'group.custom': 'Custom',
        'sound.chime': 'Bright triple chime',
        'sound.soft': 'Soft double tone',
        'sound.bell': 'Bell',
        'sound.pop': 'Light pop',
        'sound.success': 'Rising completion',
        'sound.alert': 'Double alert',
        'sound.dong': 'Deep single tone',
        'sound.swell': 'Chord swell',
        'sound.chord': 'Major triad',
        'sound.echo': 'Triple echo',
        'sound.marimba': 'Marimba',
        'sound.ding': 'Single ding',
        'sound.gliss': 'Quick glide',
        'sound.xylophone': 'Xylophone fall',
        'sound.triplet': 'Triplet skip',
        'sound.finale': 'Four-note finale',
        'sound.coin': 'Coin',
        'sound.retro': '8-bit rising',
        'sound.retroDown': '8-bit falling',
        'sound.pulse': 'Tech pulse',
        'sound.sonar': 'Sonar',
        'sound.bird': 'Bird call',
        'sound.waterdrop': 'Water drop',
        'sound.woodblock': 'Woodblock',
        'sound.pluck': 'Plucked string',
        'sound.tick': 'Light tick',
      },
    };

    const CSS = [
      '.cs-page{display:flex;flex-direction:column;gap:16px;width:100%;padding:8px 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:22px}',
      '.cs-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.cs-card{display:flex;flex-direction:column;box-sizing:border-box;padding:12px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1));border-radius:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1))}',
      '.cs-row{display:flex;align-items:center;justify-content:space-between;gap:16px;box-sizing:border-box;min-height:40px;padding:6px 0}',
      '.cs-row.cs-stack{flex-direction:column;align-items:stretch;gap:8px}',
      '.cs-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.cs-rowTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.cs-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px}',
      '.cs-divider{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.cs-inline{display:flex;align-items:center;gap:8px;min-width:0}',
      '.cs-select,.cs-input{box-sizing:border-box;height:32px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px}',
      '.cs-select{cursor:pointer;max-width:220px}',
      '.cs-input{flex:1 1 auto;min-width:0}',
      '.cs-button{box-sizing:border-box;flex:none;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:22px;cursor:pointer}',
      '.cs-button:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.cs-range{width:180px;height:32px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.cs-value{min-width:40px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:right}',
      '.cs-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .16s ease}',
      '.cs-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.cs-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.24);transition:transform .16s ease}',
      '.cs-switch[aria-checked="true"]::after{transform:translateX(16px)}',
      '.cs-switch:focus-visible,.cs-button:focus-visible,.cs-select:focus-visible,.cs-input:focus-visible,.cs-range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.cs-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
    ].join('');

    const DEFAULTS = { enabled: true, scope: 'all', sound: 'chime', errorSound: 'alert', interruptedSound: 'retroDown', volume: 0.7, customUrl: '', customName: '' };

    function clampVolume(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULTS.volume;
      return Math.min(1, Math.max(0, value));
    }

    function normalize(raw) {
      const next = { ...DEFAULTS };
      if (raw === null || typeof raw !== 'object') return next;
      if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled;
      if (raw.scope === 'all' || raw.scope === 'current') next.scope = raw.scope;
      if (typeof raw.sound === 'string' && (raw.sound === 'custom' || SOUNDS.some((item) => item.id === raw.sound))) {
        next.sound = raw.sound;
      }
      for (const key of ['errorSound', 'interruptedSound']) {
        if (raw[key] === 'none' || SOUNDS.some(item => item.id === raw[key])) next[key] = raw[key];
      }
      next.volume = clampVolume(raw.volume);
      if (typeof raw.customUrl === 'string') next.customUrl = raw.customUrl;
      if (typeof raw.customName === 'string') next.customName = raw.customName;
      return next;
    }

    function readStored() {
      try {
        const text = window.localStorage.getItem(STORAGE_KEY);
        return text === null ? null : JSON.parse(text);
      } catch (error) {
        return null;
      }
    }

    function writeStored(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch (error) {
        /* Quota or private mode: the preference still applies for this page. */
      }
    }

    /** One tiny observable store for the settings page and the watcher. */
    function createStore() {
      let value = normalize(readStored());
      const listeners = new Set();
      return {
        get: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        patch(partial) {
          value = normalize({ ...value, ...partial });
          writeStored(value);
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              /* One broken subscriber must not stop the others. */
            }
          }
          return value;
        },
      };
    }

    function useSettings(store) {
      const [value, setValue] = React.useState(store.get);
      React.useEffect(() => store.subscribe(() => setValue(store.get())), [store]);
      return value;
    }

    /** Web Audio synthesizer; the context is created lazily and unlocked by a gesture. */
    function createPlayer() {
      let audio = null;
      const clips = new Set();
      let noiseBuffer = null;

      function context() {
        if (audio !== null) return audio;
        const Ctor = typeof window === 'undefined' ? undefined : window.AudioContext || window.webkitAudioContext;
        if (typeof Ctor !== 'function') return null;
        try {
          audio = new Ctor();
        } catch (error) {
          audio = null;
        }
        return audio;
      }

      function unlock() {
        const current = context();
        if (current === null) return null;
        if (current.state === 'suspended') {
          try {
            const pending = current.resume();
            if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {});
          } catch (error) {
            /* The next gesture retries. */
          }
        }
        return current;
      }

      function envelope(param, begin, dur, peak, attack) {
        const rise = Math.max(0.002, Math.min(attack, dur * 0.6));
        param.setValueAtTime(0.0005, begin);
        param.exponentialRampToValueAtTime(peak, begin + rise);
        param.exponentialRampToValueAtTime(0.0005, begin + dur);
      }

      function noise(current) {
        if (noiseBuffer !== null && noiseBuffer.sampleRate === current.sampleRate) return noiseBuffer;
        const length = Math.max(1, Math.floor(current.sampleRate * 0.4));
        const buffer = current.createBuffer(1, length, current.sampleRate);
        const data = buffer.getChannelData(0);
        for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
        noiseBuffer = buffer;
        return buffer;
      }

      function burst(current, spec, volume, begin) {
        const source = current.createBufferSource();
        source.buffer = noise(current);
        const filter = current.createBiquadFilter();
        filter.type = spec.type === undefined ? 'bandpass' : spec.type;
        filter.frequency.setValueAtTime(spec.cutoff === undefined ? 2000 : spec.cutoff, begin);
        filter.Q.value = spec.q === undefined ? 1.2 : spec.q;
        const gain = current.createGain();
        envelope(gain.gain, begin, spec.dur, Math.max(0.0005, volume * (spec.gain === undefined ? 0.12 : spec.gain)), spec.attack === undefined ? 0.004 : spec.attack);
        source.connect(filter);
        filter.connect(gain);
        gain.connect(current.destination);
        source.onended = () => {
          try {
            source.disconnect();
            filter.disconnect();
            gain.disconnect();
          } catch (error) {
            /* Already disconnected. */
          }
        };
        source.start(begin);
        source.stop(begin + spec.dur + 0.02);
      }

      function voice(current, note, volume, start) {
        const begin = start + (note.at === undefined ? 0 : note.at);
        const dur = note.dur;
        const peak = Math.max(0.0005, volume * (note.gain === undefined ? 0.3 : note.gain));
        const attack = note.attack === undefined ? 0.012 : note.attack;

        const gain = current.createGain();
        envelope(gain.gain, begin, dur, peak, attack);
        gain.connect(current.destination);

        let head = gain;
        let filter = null;
        if (note.filter !== undefined) {
          filter = current.createBiquadFilter();
          filter.type = note.filter.type === undefined ? 'lowpass' : note.filter.type;
          filter.Q.value = note.filter.q === undefined ? 0.7 : note.filter.q;
          filter.frequency.setValueAtTime(note.filter.cutoff, begin);
          if (note.filter.to !== undefined) {
            filter.frequency.exponentialRampToValueAtTime(Math.max(40, note.filter.to), begin + dur);
          }
          filter.connect(gain);
          head = filter;
        }

        const oscillators = [];
        const make = (frequency, type, extraGain, length) => {
          const oscillator = current.createOscillator();
          oscillator.type = type;
          oscillator.frequency.setValueAtTime(frequency, begin);
          if (note.slide !== undefined && note.slide !== 1) {
            oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequency * note.slide), begin + dur);
          }
          /* The main tone rides the note envelope through `head`; each partial
             carries its own envelope so its level is independent. */
          let partial = null;
          if (extraGain === 1) {
            oscillator.connect(head);
          } else {
            partial = current.createGain();
            envelope(partial.gain, begin, length, Math.max(0.0005, peak * extraGain), attack);
            partial.connect(current.destination);
            oscillator.connect(partial);
          }
          oscillator.start(begin);
          oscillator.stop(begin + Math.max(dur, length) + 0.04);
          oscillators.push({ oscillator, partial });
        };

        const type = note.type === undefined ? 'sine' : note.type;
        make(note.f, type, 1, dur);
        for (const partial of note.partials === undefined ? [] : note.partials) {
          make(note.f * partial.ratio, partial.type === undefined ? type : partial.type, partial.gain, partial.dur === undefined ? dur : partial.dur);
        }

        const last = oscillators[oscillators.length - 1].oscillator;
        last.onended = () => {
          for (const record of oscillators) {
            try {
              record.oscillator.disconnect();
              if (record.partial !== null) record.partial.disconnect();
            } catch (error) {
              /* Already disconnected. */
            }
          }
          try {
            gain.disconnect();
            if (filter !== null) filter.disconnect();
          } catch (error) {
            /* Already disconnected. */
          }
        };

        if (note.noise !== undefined) burst(current, note.noise, volume, begin);
      }

      function render(preset, volume) {
        const current = unlock();
        if (current === null) return;
        const start = current.currentTime + 0.02;
        for (const note of preset.notes) voice(current, note, volume, start);
      }

      function clip(url, volume) {
        try {
          const element = new window.Audio(url);
          element.volume = volume;
          clips.add(element);
          const release = () => clips.delete(element);
          element.addEventListener('ended', release, { once: true });
          element.addEventListener('error', release, { once: true });
          const pending = element.play();
          if (pending !== undefined && typeof pending.catch === 'function') pending.catch(release);
          window.setTimeout(release, 20000);
        } catch (error) {
          /* Unreadable URL: stay silent rather than break the watcher. */
        }
      }

      return {
        unlock,
        play(settings, force) {
          if (force !== true && settings.enabled !== true) return;
          const volume = clampVolume(settings.volume);
          if (volume <= 0) return;
          if (settings.sound === 'custom') {
            if (typeof settings.customUrl === 'string' && settings.customUrl !== '') clip(settings.customUrl, volume);
            return;
          }
          const preset = SOUNDS.find((item) => item.id === settings.sound) || SOUNDS[0];
          render(preset, volume);
        },
      };
    }

    function apply(ctx) {
      const store = createStore();
      const player = createPlayer();
      const translate = (key) => {
        try {
          return ctx.locale.bind(NS)(key);
        } catch (error) {
          return key;
        }
      };
      const notifications = [];
      let soundTimer = null;
      let disposed = false;
      const drain = () => {
        soundTimer = null;
        while (!disposed && notifications.length > 0) {
          const notice = notifications.shift();
          const settings = store.get();
          if (!settings.enabled || (settings.scope === 'current' && !notice.visible)) continue;
          const sound = notice.kind === 'error' ? settings.errorSound : notice.kind === 'interrupted' ? settings.interruptedSound : settings.sound;
          if (sound === 'none') continue;
          player.play({ ...settings, sound }, false);
          soundTimer = window.setTimeout(drain, SOUND_GAP_MS);
          return;
        }
      };
      ctx.effect(() => () => { disposed = true; notifications.length = 0; window.clearTimeout(soundTimer); }, 'completion-sound: notification queue');

      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'completion-sound: dictionaries');

      ctx.effect(() => {
        const unlock = () => player.unlock();
        window.addEventListener('pointerdown', unlock, true);
        window.addEventListener('keydown', unlock, true);
        return () => {
          window.removeEventListener('pointerdown', unlock, true);
          window.removeEventListener('keydown', unlock, true);
        };
      }, 'completion-sound: audio unlock');

      function useLocaleVersion() {
        const [version, setVersion] = React.useState(0);
        React.useEffect(
          () => ctx.locale.subscribe(() => setVersion((current) => current + 1)),
          [],
        );
        return version;
      }

      /** DS Bot work/waits + real turn/end, not assistant text or a running edge. */
      function CompletionWatcher(props) {
        const statuses = props.useSessionStatus((snapshot) => snapshot);
        const sessions = props.useSessions((snapshot) => snapshot);
        const latest = React.useRef({ statuses, sessions });
        latest.current = { statuses, sessions };
        React.useEffect(() => {
          const tracker = createLifecycleTracker();
          return startLifecycleMonitor({
            fetch: (...args) => window.fetch(...args),
            getNative: () => latest.current,
            schedule: (fn, ms) => window.setTimeout(fn, ms),
            cancel: id => window.clearTimeout(id),
            onFrame: frame => {
              const notices = tracker.advance(frame, Date.now());
              if (notices.length === 0 || disposed) return;
              notifications.push(...notices);
              if (soundTimer === null) drain();
            },
          });
        }, []);
        return null;
      }

      /** Navigation glyph for the Settings section. */
      function SoundNavIcon(props) {
        const size = typeof props.size === 'number' ? props.size : 16;
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('path', { d: 'M2.6 6.1h2.2L7.6 3.4v9.2L4.8 9.9H2.6z' }),
          h('path', { d: 'M10 5.6a3.4 3.4 0 0 1 0 4.8' }),
          h('path', { d: 'M12.2 3.6a6.4 6.4 0 0 1 0 8.8' }),
        );
      }

      /** Settings section page. */
      function SoundSection() {
        useLocaleVersion();
        const settings = useSettings(store);
        const [error, setError] = React.useState('');
        const fileRef = React.useRef(null);
        const t = translate;

        const update = (partial) => {
          setError('');
          store.patch(partial);
        };

        const choose = (value) => {
          update({ sound: value });
          if (value !== 'custom') player.play(store.get(), true);
        };

        const preview = () => {
          const current = store.get();
          if (current.sound === 'custom' && current.customUrl === '') {
            setError(t('row.emptyUrl'));
            return;
          }
          setError('');
          player.play(current, true);
        };

        const pickFile = (event) => {
          const input = event.target;
          const file = input.files === undefined || input.files === null ? undefined : input.files[0];
          if (file === undefined) return;
          if (file.size > MAX_FILE_BYTES) {
            setError(t('row.fileTooLarge'));
            input.value = '';
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const url = typeof reader.result === 'string' ? reader.result : '';
            if (url === '') {
              setError(t('row.readFailed'));
              return;
            }
            setError('');
            store.patch({ sound: 'custom', customUrl: url, customName: file.name });
          };
          reader.onerror = () => setError(t('row.readFailed'));
          try {
            reader.readAsDataURL(file);
          } catch (caught) {
            setError(t('row.readFailed'));
          }
          input.value = '';
        };

        const isData = settings.customUrl.startsWith('data:');

        const row = (title, desc, control) =>
          h(
            'div',
            { className: 'cs-row' },
            h(
              'div',
              { className: 'cs-rowText' },
              h('div', { className: 'cs-rowTitle' }, title),
              desc === undefined ? null : h('div', { className: 'cs-rowDesc' }, desc),
            ),
            h('div', { className: 'cs-inline' }, control),
          );

        const outcomeRow = (key) => row(
          t('row.' + key + '.title'), t('row.' + key + '.desc'),
          h(React.Fragment, null,
            h('select', { className: 'cs-select', value: settings[key], 'aria-label': t('row.' + key + '.title'),
              onChange: event => { const sound = event.target.value; update({ [key]: sound }); if (sound !== 'none') player.play({ ...store.get(), sound }, true); } },
              h('option', { value: 'none' }, t('row.none')),
              GROUPS.map(group => h('optgroup', { key: group.id, label: t('group.' + group.id) },
                SOUNDS.filter(sound => sound.group === group.id).map(sound => h('option', { key: sound.id, value: sound.id }, t('sound.' + sound.id)))))),
            h('button', { type: 'button', className: 'cs-button', disabled: settings[key] === 'none',
              onClick: () => player.play({ ...store.get(), sound: store.get()[key] }, true) }, t('row.preview'))));

        return h(
          React.Fragment,
          null,
          h('style', null, CSS),
          h(
            'div',
            { className: 'cs-page' },
            h('p', { className: 'cs-intro' }, t('page.intro')),
            h(
              'div',
              { className: 'cs-card' },
              row(
                t('row.enable.title'),
                t('row.enable.desc'),
                h('button', {
                  type: 'button',
                  role: 'switch',
                  className: 'cs-switch',
                  'aria-checked': settings.enabled === true,
                  'aria-label': t('row.enable.aria'),
                  onClick: () => update({ enabled: settings.enabled !== true }),
                }),
              ),
              h('div', { className: 'cs-divider' }),
              row(
                t('row.scope.title'),
                t('row.scope.desc'),
                h(
                  'select',
                  {
                    className: 'cs-select',
                    value: settings.scope,
                    onChange: (event) => update({ scope: event.target.value }),
                  },
                  h('option', { value: 'all' }, t('row.scopeAll')),
                  h('option', { value: 'current' }, t('row.scopeCurrent')),
                ),
              ),
            ),
            h(
              'div',
              { className: 'cs-card' },
              row(
                t('row.sound.title'),
                t('row.sound.desc'),
                h(
                  React.Fragment,
                  null,
                  h(
                    'select',
                    {
                      className: 'cs-select',
                      value: settings.sound,
                      onChange: (event) => choose(event.target.value),
                    },
                    GROUPS.map((group) =>
                      h(
                        'optgroup',
                        { key: group.id, label: t('group.' + group.id) },
                        SOUNDS.filter((sound) => sound.group === group.id).map((sound) =>
                          h('option', { key: sound.id, value: sound.id }, t('sound.' + sound.id)),
                        ),
                      ),
                    ),
                    h(
                      'optgroup',
                      { key: 'custom', label: t('group.custom') },
                      h('option', { value: 'custom' }, t('row.custom')),
                    ),
                  ),
                  h('button', { type: 'button', className: 'cs-button', onClick: preview }, t('row.preview')),
                ),
              ),
              h('div', { className: 'cs-divider' }),
              outcomeRow('errorSound'),
              h('div', { className: 'cs-divider' }),
              outcomeRow('interruptedSound'),
              h('div', { className: 'cs-divider' }),
              row(
                t('row.volume.title'),
                t('row.volume.desc'),
                h(
                  React.Fragment,
                  null,
                  h('input', {
                    className: 'cs-range',
                    type: 'range',
                    min: 0,
                    max: 100,
                    step: 5,
                    value: Math.round(settings.volume * 100),
                    'aria-label': t('row.volume.title'),
                    onChange: (event) => store.patch({ volume: Number(event.target.value) / 100 }),
                  }),
                  h('span', { className: 'cs-value' }, Math.round(settings.volume * 100) + '%'),
                ),
              ),
              settings.sound === 'custom' ? h('div', { className: 'cs-divider' }) : null,
              settings.sound === 'custom'
                ? h(
                    'div',
                    { className: 'cs-row cs-stack' },
                    h(
                      'div',
                      { className: 'cs-rowText' },
                      h('div', { className: 'cs-rowTitle' }, t('row.custom.title')),
                      h('div', { className: 'cs-rowDesc' }, t('row.custom.desc')),
                    ),
                    h(
                      'div',
                      { className: 'cs-inline' },
                      h('input', {
                        className: 'cs-input',
                        type: 'text',
                        value: isData ? '' : settings.customUrl,
                        placeholder: isData ? settings.customName || t('row.fileLoaded') : t('row.customPlaceholder'),
                        onChange: (event) => update({ customUrl: event.target.value, customName: '' }),
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'cs-button',
                          onClick: () => {
                            if (fileRef.current !== null) fileRef.current.click();
                          },
                        },
                        t('row.pickFile'),
                      ),
                      settings.customUrl === ''
                        ? null
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'cs-button',
                              onClick: () => update({ customUrl: '', customName: '' }),
                            },
                            t('row.clear'),
                          ),
                    ),
                    h('input', {
                      ref: fileRef,
                      type: 'file',
                      accept: 'audio/*',
                      style: { display: 'none' },
                      onChange: pickFile,
                    }),
                  )
                : null,
              error === '' ? null : h('div', { className: 'cs-error', role: 'alert' }, error),
            ),
          ),
        );
      }

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'completion-sound', order: 5, label: () => translate('section.label') },
          SoundSection,
        ),
      );

      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register({ name: 'settings.section.icon', id: 'completion-sound' }, SoundNavIcon),
      );

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'completion-sound-watch' }, CompletionWatcher),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
