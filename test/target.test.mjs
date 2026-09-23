import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTextDirective,
  buildTargetUrl,
  stripFragmentDirective,
  applyMediaTime,
  formatScroll,
  formatDuration,
  supportsTextFragments,
} from '../shared/target.js';

test('short snippets become a whole-phrase text directive', () => {
  assert.equal(makeTextDirective('the mask pattern matters'), 'the%20mask%20pattern%20matters');
});

test('long snippets use the start,end form', () => {
  const snippet =
    'Reed Solomon coding is the reason a torn or partially obscured code still ' +
    'scans correctly on the first try every single time you point a camera at it';
  const directive = makeTextDirective(snippet);
  const [start, end] = directive.split(',');
  assert.equal(decodeURIComponent(start), 'Reed Solomon coding is the reason');
  assert.equal(decodeURIComponent(end), 'you point a camera at it');
});

test('characters that would break the directive grammar are escaped', () => {
  // A literal `-`, `,` or `&` in the text would be read as directive syntax.
  const directive = makeTextDirective('cost, benefit & trade-offs in design');
  assert.ok(!directive.includes(','), directive);
  assert.ok(!directive.includes('&'), directive);
  assert.ok(!directive.includes('-'), directive);
  assert.equal(decodeURIComponent(directive), 'cost, benefit & trade-offs in design');
});

test('a prefix is emitted in the spec"s prefix-, form', () => {
  const directive = makeTextDirective('the same paragraph again', { prefix: 'third time' });
  assert.ok(directive.startsWith('third%20time-,'), directive);
});

test('snippets too short to match reliably are refused', () => {
  assert.equal(makeTextDirective('ok'), null);
  assert.equal(makeTextDirective('   '), null);
});

test('target URLs put the fragment directive after any existing hash', () => {
  const state = { url: 'https://example.com/doc#section-3', fragment: 'hello%20there' };
  assert.equal(
    buildTargetUrl(state),
    'https://example.com/doc#section-3:~:text=hello%20there',
  );
});

test('target URLs add a hash when the page had none', () => {
  const state = { url: 'https://example.com/doc', fragment: 'hello%20there' };
  assert.equal(buildTargetUrl(state), 'https://example.com/doc#:~:text=hello%20there');
});

test('an element id is used when there is no text to match', () => {
  const state = { url: 'https://example.com/doc', anchor: 'installation' };
  assert.equal(buildTargetUrl(state), 'https://example.com/doc#installation');
});

test('turning position off yields the bare page', () => {
  const state = {
    url: 'https://example.com/doc',
    fragment: 'hello',
    anchor: 'x',
    scroll: 0.5,
  };
  assert.equal(buildTargetUrl(state, { position: false }), 'https://example.com/doc');
});

test('a stale fragment directive from a previous handoff is dropped', () => {
  assert.equal(
    stripFragmentDirective('https://example.com/doc#s1:~:text=old%20thing'),
    'https://example.com/doc#s1',
  );
  assert.equal(
    buildTargetUrl({ url: 'https://example.com/d#:~:text=old', fragment: 'new' }),
    'https://example.com/d#:~:text=new',
  );
});

test('YouTube resumes where the video was', () => {
  assert.equal(
    applyMediaTime('https://www.youtube.com/watch?v=abc123', { seconds: 754 }),
    'https://www.youtube.com/watch?v=abc123&t=754',
  );
  assert.equal(
    applyMediaTime('https://youtu.be/abc123', { seconds: 30 }),
    'https://youtu.be/abc123?t=30',
  );
});

test('an existing timestamp is replaced rather than duplicated', () => {
  assert.equal(
    applyMediaTime('https://www.youtube.com/watch?v=abc&t=10', { seconds: 200 }),
    'https://www.youtube.com/watch?v=abc&t=200',
  );
});

test('sites with no known seek syntax are left untouched', () => {
  const url = 'https://example.com/lecture';
  assert.equal(applyMediaTime(url, { seconds: 300 }), url);
  assert.equal(applyMediaTime(url, { seconds: 2 }), url, 'and trivial offsets are ignored');
});

test('scroll and duration read as English', () => {
  assert.equal(formatScroll(0), 'top of page');
  assert.equal(formatScroll(0.423), '42% down');
  assert.equal(formatScroll(1), 'bottom of page');
  assert.equal(formatScroll(undefined), null);
  assert.equal(formatDuration(91), '1:31');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('text fragment support is detected from the Safari version', () => {
  const check = (userAgent) => supportsTextFragments({ userAgent });
  assert.equal(
    check(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ),
    true,
  );
  assert.equal(
    check(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/15.6 Safari/605.1.15',
    ),
    false,
  );
});
