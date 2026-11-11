// The T3 Connect routes only the relay or a client-driven link call (step 3+, plan section 5; review finding 1),
// refused by the Environment DO before t3 boots, for any method. t3's own app refuses them too (connect/service.ts,
// `layerRefusingCloudLink`): this is the outer layer. A path is compared after percent-decoding, dot segments,
// repeated and trailing slashes, `;` parameters and case, so no spelling t3's router could still match gets past.
const REFUSED = new Set(["/api/connect/link-proof", "/api/connect/relay-config", "/api/t3-connect/health", "/api/t3-connect/mint-credential"]);

const normalize = (pathname: string): string | undefined => {
  let decoded = pathname;
  // Twice, so an encoded `%` (`%25…`) is decoded as a router that decodes once more would.
  for (let round = 0; round < 2; round++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return undefined;
    }
  }
  const segments: Array<string> = [];
  for (const raw of decoded.toLowerCase().split("/")) {
    const segment = raw.split(";")[0]!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

export const isRefusedRelayRoute = (pathname: string): boolean => {
  const path = normalize(pathname);
  // A Connect path that cannot be decoded is refused: fail closed (t3 would not route it anyway).
  return path === undefined ? /connect/i.test(pathname) : REFUSED.has(path);
};
