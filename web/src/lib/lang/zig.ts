// Zig for highlight.js, which has no Zig of its own: keywords, builtins (@import), types,
// strings (incl. \\ multiline lines), chars, numbers, comments (// /// //!), fn names.
import type { HLJSApi, Language } from "highlight.js";

export default function zig(hljs: HLJSApi): Language {
  const KEYWORDS = {
    keyword: "addrspace align allowzero and anyframe anytype asm break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while async await",
    literal: "true false null undefined",
    type: "bool void noreturn type anyerror anyopaque comptime_int comptime_float isize usize c_char c_short c_ushort c_int c_uint c_long c_ulong c_longlong c_ulonglong c_longdouble f16 f32 f64 f80 f128",
  };
  return {
    name: "Zig",
    aliases: ["zig", "zon"],
    keywords: KEYWORDS,
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      { scope: "string", begin: /\\\\/, end: /$/ }, // multiline string line
      { scope: "string", begin: /"/, end: /"/, illegal: /\n/, contains: [hljs.BACKSLASH_ESCAPE] },
      { scope: "string", begin: /'(\\.|[^'\\])+'/ },
      { scope: "built_in", begin: /@[A-Za-z_]\w*/ },
      { scope: "type", begin: /\b[iu](0|[1-9]\d*)\b/ },
      { scope: "number", begin: /\b(0x[\da-fA-F_]+(\.[\da-fA-F_]*)?([pP][+-]?\d+)?|0o[0-7_]+|0b[01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)\b/, relevance: 0 },
      { match: [/\bfn\s+/, /[A-Za-z_]\w*/], scope: { 2: "title.function" } },
      { match: [/\b(?:const|var)\s+/, /[A-Z]\w*/, /\s*=\s*(?:extern\s+|packed\s+)?(?:struct|enum|union|opaque)\b/], scope: { 2: "title.class" } },
      { scope: "type", begin: /\b[A-Z][a-zA-Z0-9]*\b/, relevance: 0 },
    ],
  };
}
