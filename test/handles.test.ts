import { describe, expect, it } from 'vitest'
import { accountHost, findHandles, itemHandles, visibleText } from '../src/handles.js'

describe('handles (RFC-11)', () => {
  it('finds handles, not e-mail and fediverse addresses, names without a dot or paths', () => {
    expect(findHandles('Great talk by @Tim.Example.com yesterday. Thanks, @alice.pups.test.')).toEqual(['tim.example.com', 'alice.pups.test'])
    expect(findHandles('(@a.example), "@b.example"! @c.example: @d.example;')).toEqual(['a.example', 'b.example', 'c.example', 'd.example'])
    expect(findHandles('tim@tim.example.com @tim@social.example @x.example/path @x-.example @nolabel @foobar @1.2 x@y.example.com .@z.example')).toEqual([])
    expect(findHandles('@x.example.com- @x.example_y @a.example.com.au @b.example.com-y')).toEqual(['a.example.com.au', 'b.example.com-y'])
    expect(findHandles('https://social.example/@foo.bar and @twice.example @Twice.Example')).toEqual(['twice.example'])
    expect(findHandles('Grüße an @bücher.example')).toEqual(['xn--bcher-kva.example'])
  })

  it('takes lists separated by ",", ";" or "/", and handles at the end of a sentence', () => {
    expect(findHandles('@foo.com,@bar.com;@baz.com')).toEqual(['foo.com', 'bar.com', 'baz.com'])
    expect(findHandles('(@foo.com, @bar.com; @baz.com).')).toEqual(['foo.com', 'bar.com', 'baz.com'])
    expect(findHandles('I did this thanks to @foo.com. And @bar.com!\nAlso @baz.com.')).toEqual(['foo.com', 'bar.com', 'baz.com'])
    expect(findHandles('Thanks to @a.example/@b.example/@c.example!')).toEqual(['a.example', 'b.example', 'c.example'])
    expect(findHandles('@a.example/@b.example/path @a.example/@nodot x/@d.example')).toEqual([])
  })

  it('reads the visible text of HTML: link text, but not code, attributes or hidden elements', () => {
    expect(visibleText('<p>Hi <a href="https://x.example/@no.example">@alice.example</a></p><pre>@code.example</pre>', true)).toBe('Hi @alice.example')
    expect(visibleText('<p>a&amp;b&#64;c &lt;x&gt;</p><script>@s.example</script><!-- @c.example --><code>@k.example</code>')).toBe('a&b@c <x> @k.example')
    expect(itemHandles({ title: 'For @t.example', content_html: '<p>and <b>@h.example</b><code>@c.example</code><img alt="@i.example"></p>', content_text: '@ignored.example' }))
      .toEqual(['t.example', 'h.example'])
    expect(itemHandles({ content_text: 'Plain @p.example' })).toEqual(['p.example'])
  })

  it('reads accounts', () => {
    expect([accountHost('@Bob.Example'), accountHost('bob.example'), accountHost('@a@b.example'), accountHost(3)]).toEqual(['bob.example', undefined, undefined, undefined])
  })
})
