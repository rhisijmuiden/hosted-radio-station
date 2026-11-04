/** The licence of this software and where its source code is (AGPL-3.0 section 13: offered to every network user). */
export const LICENCE = 'AGPL-3.0-or-later';
export const SOURCE_URL = 'https://github.com/rhisijmuiden/hosted-radio-station';
/** The source of the version that runs: the commit when the server knows it. */
export const sourceAt = (commit?: string | null) => (commit ? `${SOURCE_URL}/tree/${commit}` : SOURCE_URL);
export const LICENCE_URL = `${SOURCE_URL}/blob/main/LICENSE`;
