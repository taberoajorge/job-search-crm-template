// The web-standard URL APIs that browsers, Node and Deno all provide. Runtime contracts code is
// typechecked without DOM or @types/node globals (tsconfig.json "types": []), so only these exist.
declare class URLSearchParams {
  constructor(init?: Record<string, string>);
  set(name: string, value: string): void;
  get(name: string): string | null;
  toString(): string;
}
declare class URL {
  constructor(url: string, base?: string);
  static canParse(url: string, base?: string): boolean;
  readonly href: string;
  readonly protocol: string;
  readonly searchParams: URLSearchParams;
  toString(): string;
}
