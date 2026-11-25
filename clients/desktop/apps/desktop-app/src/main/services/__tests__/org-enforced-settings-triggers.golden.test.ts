import { EventEmitter } from 'node:events';
import {
  startOrgEnforcedSettingsSync,
  stopOrgEnforcedSettingsSync,
} from '../org-enforced-settings';

// Golden (CAN-7640): a web change to the account, such as turning an AI
// gateway on, has no push channel to a running desktop. Window focus, resume
// and unlock re-read the account at most once per 30 seconds; a trigger inside
// that window waits on one setTimeout for its end instead of being dropped.
// The 20-minute loop stays as the backstop.
describe('org-enforced settings sync triggers', () => {
  let app: EventEmitter;
  let powerMonitor: EventEmitter;
  let reprobe: jest.Mock<Promise<void>, []>;

  beforeEach(() => {
    jest.useFakeTimers();
    app = new EventEmitter();
    powerMonitor = new EventEmitter();
    reprobe = jest.fn(() => Promise.resolve());
  });

  afterEach(() => {
    stopOrgEnforcedSettingsSync();
    jest.useRealTimers();
  });

  it('re-reads the account on window focus after the throttle window', () => {
    startOrgEnforcedSettingsSync(reprobe, { app, powerMonitor });
    expect(reprobe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(31_000);
    app.emit('browser-window-focus');
    expect(reprobe).toHaveBeenCalledTimes(2);
  });

  it('defers a focus inside the window to one trailing re-read', () => {
    startOrgEnforcedSettingsSync(reprobe, { app, powerMonitor });
    jest.advanceTimersByTime(5_000);
    app.emit('browser-window-focus');
    app.emit('browser-window-focus');
    expect(reprobe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(24_999);
    expect(reprobe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(reprobe).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(120_000);
    expect(reprobe).toHaveBeenCalledTimes(2);
  });

  it('re-reads on resume and unlock-screen', () => {
    startOrgEnforcedSettingsSync(reprobe, { app, powerMonitor });
    jest.advanceTimersByTime(31_000);
    powerMonitor.emit('resume');
    expect(reprobe).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(31_000);
    powerMonitor.emit('unlock-screen');
    expect(reprobe).toHaveBeenCalledTimes(3);
  });

  it('keeps the 20-minute loop', () => {
    startOrgEnforcedSettingsSync(reprobe, { app, powerMonitor });
    jest.advanceTimersByTime(20 * 60_000);
    expect(reprobe).toHaveBeenCalledTimes(2);
  });

  it('removes its listeners and pending re-read on stop', () => {
    startOrgEnforcedSettingsSync(reprobe, { app, powerMonitor });
    jest.advanceTimersByTime(5_000);
    app.emit('browser-window-focus');
    stopOrgEnforcedSettingsSync();
    expect(app.listenerCount('browser-window-focus')).toBe(0);
    expect(powerMonitor.listenerCount('resume')).toBe(0);
    expect(powerMonitor.listenerCount('unlock-screen')).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(reprobe).toHaveBeenCalledTimes(1);
  });

  it('does not stack listeners on a repeat start', () => {
    startOrgEnforcedSettingsSync(reprobe, { app, powerMonitor });
    startOrgEnforcedSettingsSync(reprobe, { app, powerMonitor });
    expect(app.listenerCount('browser-window-focus')).toBe(1);
  });
});
