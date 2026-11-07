/**
 * services.worker.js — the SERVICES decoders (DSC, time signals,
 * HF Selcall) off the main thread. HFDL keeps its own worker (hfdl.worker.js)
 * because its engine is a large WebAssembly module.
 *
 * One engine runs at a time, chosen with { t: 'service' }.
 *
 * Main → worker (field `t`):
 *   { t: 'init',    sampleRate, service, opts, enabled }
 *   { t: 'service', service, opts }       switch engine (resets it)
 *   { t: 'opts',    opts }                 e.g. { centerHz }
 *   { t: 'enable',  on }
 *   { t: 'pcm',     pcm: Float32Array, sampleRate }   (buffer transferred)
 *   { t: 'reset' }
 *
 * Worker → main (field `type`):
 *   { type: 'message', service, msg }     one decoded call / frame / time
 *   { type: 'status',  service, text }
 *   { type: 'metrics', service, ... }
 *   { type: 'error',   message }
 */

import { DscDecoder } from './dsc.js';
import { TimeSignalDecoder } from './timesig.js';

let sampleRate = 12000;
let enabled = false;
let service = '';
let opts = {};
let engine = null;

const post = (m) => { try { self.postMessage(m); } catch (_) {} };

function build() {
  engine = null;
  const common = {
    sampleRate: () => sampleRate,
    onMessage: (msg) => post({ type: 'message', service, msg }),
    onStatus: (text) => post({ type: 'status', service, text }),
    onMetrics: (m) => post({ type: 'metrics', service, ...m }),
  };
  try {
    if (service === 'dsc') engine = new DscDecoder({ ...common, centerHz: opts.centerHz || 1700 });
    else if (service === 'time') engine = new TimeSignalDecoder({ ...common, station: opts.station || 'dcf77' });
    else if (service === 'selcall') engine = new DscDecoder({ ...common, centerHz: opts.centerHz || 1700, selcall: true });
  } catch (e) {
    post({ type: 'error', message: String(e && e.message || e) });
  }
}

self.onmessage = ({ data }) => {
  const m = data || {};
  switch (m.t) {
    case 'init':
      sampleRate = m.sampleRate || 12000;
      enabled = !!m.enabled;
      service = m.service || '';
      opts = m.opts || {};
      build();
      break;
    case 'service':
      service = m.service || '';
      opts = m.opts || {};
      build();
      break;
    case 'opts':
      opts = { ...opts, ...(m.opts || {}) };
      if (engine && engine.setCenter && opts.centerHz) engine.setCenter(opts.centerHz);
      if (engine && engine.setStation && opts.station) engine.setStation(opts.station);
      break;
    case 'enable':
      enabled = !!m.on;
      if (!enabled && engine && engine.reset) engine.reset();
      break;
    case 'reset':
      if (engine && engine.reset) engine.reset();
      break;
    case 'pcm':
      if (!enabled || !engine || !m.pcm) return;
      if (m.sampleRate && m.sampleRate !== sampleRate) sampleRate = m.sampleRate;
      try { engine.feed(m.pcm); }
      catch (e) { post({ type: 'error', message: String(e && e.message || e) }); }
      break;
  }
};
