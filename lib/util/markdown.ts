import type { Nodes } from 'mdast';
import { remark } from 'remark';
import gfm from 'remark-gfm';
import type { Options as RemarkGithubOptions } from 'remark-github';
import github from 'remark-github';
import { regEx } from './regex.ts';

// Generic replacements/link-breakers
export function sanitizeMarkdown(
  markdown: string,
  preserveFormatting = false,
): string {
  return preserveFormatting
    ? transformMarkdownText(markdown, sanitizeMarkdownText)
    : sanitizeMarkdownText(markdown);
}

/** Transform surrounding Markdown while preserving links, code and escapes. */
export function transformMarkdownText(
  content: string,
  transform: (text: string) => string,
): string {
  const ranges: [number, number][] = [];
  function visit(node: Nodes): void {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (
        [
          'code',
          'inlineCode',
          'link',
          'linkReference',
          'definition',
          'html',
        ].includes(node.type)
      ) {
        ranges.push([start, end]);
        return;
      }
      if (node.type === 'text') {
        const raw = content.slice(start, end);
        for (const match of raw.matchAll(regEx(/\\[\s\S]/g))) {
          ranges.push([
            start + match.index,
            start + match.index + match[0].length,
          ]);
        }
      }
    }
    if ('children' in node) {
      node.children.forEach(visit);
    }
  }
  visit(remark().use(gfm).parse(content));
  let prefix = 'RENOVATE_PRESERVED_MARKDOWN_';
  while (content.includes(prefix)) {
    prefix += '_';
  }
  let protectedContent = content;
  for (let index = ranges.length - 1; index >= 0; index--) {
    const [start, end] = ranges[index];
    protectedContent = `${protectedContent.slice(0, start)}${prefix}${index}_${protectedContent.slice(end)}`;
  }
  let result = transform(protectedContent);
  for (const [index, [start, end]] of ranges.entries()) {
    result = result.replace(`${prefix}${index}_`, () =>
      content.slice(start, end),
    );
  }
  return result;
}

function sanitizeMarkdownText(markdown: string): string {
  let res = markdown;
  // Put a zero width space after every # followed by a digit
  res = res.replace(
    regEx(/(?<pre>\W)#(?<digit>\d)/gi),
    '$<pre>#&#8203;$<digit>',
  );
  // Put a zero width space after every @ symbol to prevent unintended hyperlinking,
  // but leave URLs, code blocks (triple backticks), and inline code spans untouched
  res = res
    .split(regEx(/(?<skip>```[\s\S]*?```|`[^`\n]*?`|https?:\/\/[^\s<]+)/gi))
    .map((part) =>
      part.startsWith('`') || regEx(/^https?:\/\//i).test(part)
        ? part
        : part.replace(regEx(/@/g), '@&#8203;'),
    )
    .join('');
  res = res.replace(regEx(/(?<pre>[a-z]@)&#8203;/gi), '$<pre>');
  res = res.replace(regEx(/\/compare\/@&#8203;/g), '/compare/@');
  res = res.replace(
    regEx(/(?<pre>\(https:\/\/[^)]*?)\.\.\.@&#8203;/g),
    '$<pre>...@',
  );
  res = res.replace(
    regEx(/(?<pre>[\s(])#(?<digits>\d+)(?<post>[)\s]?)/g),
    '$<pre>#&#8203;$<digits>$<post>',
  );
  // convert escaped backticks back to `
  const backTickRe = regEx(/&#x60;(?<content>[^/]*?)&#x60;/g);
  res = res.replace(backTickRe, '`$<content>`');
  res = res.replace(regEx(/`#&#8203;(?<digits>\d+)`/g), '`#$<digits>`');
  res = res.replace(
    regEx(/(?<before>[^\n]\n)(?<title>#.*)/g),
    '$<before>\n$<title>',
  );
  return res;
}

/**
 *
 * @param content content to process
 * @param options github options
 * @returns linkified content
 */
export async function linkify(
  content: string,
  options: RemarkGithubOptions,
): Promise<string> {
  // https://github.com/syntax-tree/mdast-util-to-markdown#optionsbullet
  const output = await remark()
    .use({ settings: { bullet: '-' } })
    .use(gfm)
    .use(github, { mentionStrong: false, ...options })
    .process(content);
  return output.toString();
}
