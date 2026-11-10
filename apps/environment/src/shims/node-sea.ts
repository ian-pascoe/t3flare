// `node:sea` does not exist in workerd; t3 only asks whether it runs as a single
// executable application, which a Worker never is.
export const isSea = (): boolean => false;
export const getRawAsset = (key: string): ArrayBuffer => {
  throw new Error(`t3flare: no single-executable asset '${key}'`);
};
export const getAsset = getRawAsset;
export const getAssetAsBlob = getRawAsset;
export default { isSea, getRawAsset, getAsset, getAssetAsBlob };
