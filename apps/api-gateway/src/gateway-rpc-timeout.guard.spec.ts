import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Resilience guard (audit #8): every gateway → microservice RPC must be
 * bounded by an rxjs `timeout(...)`. An unbounded `client.send()` hangs the
 * HTTP request forever when a downstream service wedges, holding the
 * connection and eventually starving the gateway. This test statically scans
 * every controller and fails if a `this.<x>Client.send(...)` is not immediately
 * followed by `.pipe(...)` containing a `timeout`. It is a lint-style backstop:
 * if it trips, wrap the new send with `.pipe(timeout(<tier>))`.
 */
describe('gateway RPC sends are all timeout-bounded', () => {
  const srcDir = __dirname;
  const sendRe = /this\.\w+Client\s*\.\s*send/g;

  const findUntimed = (src: string): number[] => {
    const untimed: number[] = [];
    let m: RegExpExecArray | null;
    sendRe.lastIndex = 0;
    while ((m = sendRe.exec(src)) !== null) {
      let k = m.index + m[0].length;
      const skipWs = () => {
        while (k < src.length && /\s/.test(src[k])) k++;
      };
      skipWs();
      // skip an optional <...> generic type argument
      if (src[k] === '<') {
        let d = 0;
        while (k < src.length) {
          if (src[k] === '<') d++;
          else if (src[k] === '>') {
            d--;
            if (d === 0) {
              k++;
              break;
            }
          }
          k++;
        }
      }
      skipWs();
      if (src[k] !== '(') continue;
      // balance the call's parens
      let depth = 0;
      let c = k;
      while (c < src.length) {
        if (src[c] === '(') depth++;
        else if (src[c] === ')') {
          depth--;
          if (depth === 0) break;
        }
        c++;
      }
      // look ahead past whitespace for `.pipe(` ... `timeout`
      let la = c + 1;
      while (la < src.length && /\s/.test(src[la])) la++;
      const tail = src.slice(la, la + 200);
      const piped = tail.startsWith('.pipe(');
      const hasTimeout = piped && /\.pipe\(\s*[^)]*timeout\s*\(/.test(tail);
      if (!piped || !hasTimeout) {
        untimed.push(src.slice(0, m.index).split('\n').length);
      }
    }
    return untimed;
  };

  const controllers = readdirSync(srcDir).filter((f) =>
    f.endsWith('.controller.ts'),
  );

  it('scans a non-trivial number of controllers', () => {
    // guard against the glob silently matching nothing
    expect(controllers.length).toBeGreaterThan(10);
  });

  it.each(controllers)('%s has no unbounded client.send()', (file) => {
    const src = readFileSync(join(srcDir, file), 'utf8');
    const untimed = findUntimed(src);
    expect({ file, untimedAtLines: untimed }).toEqual({
      file,
      untimedAtLines: [],
    });
  });
});
