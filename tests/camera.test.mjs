import test from 'node:test';
import assert from 'node:assert/strict';
import { openCameraStream } from '../tracking.mjs';

const phone = { kind: 'videoinput', deviceId: 'new-phone-id', label: 'iPhone Continuity Camera' };
const mac = { kind: 'videoinput', deviceId: 'mac', label: 'FaceTime HD Camera' };
function stream(id, stop = () => {}) {
  const track = { getSettings: () => ({ deviceId: id }), stop };
  return { getTracks: () => [track], getVideoTracks: () => [track] };
}
test('stale Continuity Camera IDs are rediscovered and initial zoom constraints are omitted', async () => {
  const expected = stream(phone.deviceId);
  const media = {
    enumerateDevices: async () => [mac, phone],
    getUserMedia: async constraints => {
      assert.equal(constraints.video.deviceId.exact, phone.deviceId);
      assert.equal(constraints.video.zoom, undefined);
      return expected;
    }
  };
  assert.equal((await openCameraStream(media, 'iphone', 'old-phone-id')).stream, expected);
});
test('discovery reuses a permission stream already coming from the iPhone', async () => {
  let open = false, stopped = 0, requests = 0;
  const expected = stream(phone.deviceId, () => stopped++);
  const media = {
    enumerateDevices: async () => open ? [phone] : [{ ...phone, label: '' }],
    getUserMedia: async () => { open = true; requests++; return expected; }
  };
  assert.equal((await openCameraStream(media, 'iphone')).stream, expected);
  assert.equal(requests, 1); assert.equal(stopped, 0);
});
test('discovery stream stays open until iPhone handover completes', async () => {
  const events = [];
  let authorized = false;
  const media = {
    enumerateDevices: async () => authorized ? [mac, phone] : [{ ...mac, label: '' }],
    getUserMedia: async ({ video }) => {
      if (video === true) { authorized = true; events.push('permission'); return stream('mac', () => events.push('stop permission')); }
      events.push('open phone'); return stream(phone.deviceId);
    }
  };
  assert.equal((await openCameraStream(media, 'iphone')).selected.deviceId, phone.deviceId);
  assert.deepEqual(events, ['permission', 'open phone', 'stop permission']);
});
test('missing iPhone reports an error and never substitutes the computer camera', async () => {
  let stopped = false;
  const media = { enumerateDevices: async () => [mac], getUserMedia: async () => stream('mac', () => stopped = true) };
  await assert.rejects(openCameraStream(media, 'iphone'), { name: 'IPhoneCameraNotFound' });
  assert.equal(stopped, true);
});
test('failed resolution request retries the exact iPhone with basic constraints', async () => {
  let count = 0;
  const media = {
    enumerateDevices: async () => [mac, phone],
    getUserMedia: async ({ video }) => {
      if (++count === 1) throw Object.assign(new Error('unsupported size'), { name: 'OverconstrainedError' });
      assert.deepEqual(video, { deviceId: { exact: phone.deviceId } });
      return stream(phone.deviceId);
    }
  };
  await openCameraStream(media, 'iphone'); assert.equal(count, 2);
});
