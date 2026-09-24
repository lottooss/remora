import koffi from 'koffi';
import { execSync } from 'node:child_process';

const ES_SYSTEM_REQUIRED = 0x00000001;
const ES_CONTINUOUS = 0x80000000;

console.log('=== P0-S6 Keep-Awake Probe ===');

try {
  const kernel32 = koffi.load('kernel32.dll');
  const SetThreadExecutionState = kernel32.func('uint32 __stdcall SetThreadExecutionState(uint32 esFlags)');

  console.log('[1] Initial powercfg /requests:');
  try {
    const before = execSync('powercfg /requests', { encoding: 'utf8' });
    console.log(before.split('\n').slice(0, 8).join('\n'));
  } catch (e) {
    console.log('powercfg query error:', e.message);
  }

  console.log('\n[2] Setting ES_CONTINUOUS | ES_SYSTEM_REQUIRED (0x80000001)...');
  const prevState = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
  console.log(`Previous execution state: 0x${prevState.toString(16)}`);

  console.log('\n[3] Current powercfg /requests while held:');
  try {
    const during = execSync('powercfg /requests', { encoding: 'utf8' });
    console.log(during.split('\n').slice(0, 10).join('\n'));
  } catch (e) {
    console.log('powercfg query error:', e.message);
  }

  console.log('\n[4] Releasing execution state (ES_CONTINUOUS)...');
  SetThreadExecutionState(ES_CONTINUOUS);
  console.log('Execution state released.');

} catch (err) {
  console.error('Failed to invoke SetThreadExecutionState via koffi:', err);
  process.exit(1);
}
