// SPDX-License-Identifier: AGPL-3.0-or-later

const SOURCE_URL = import.meta.env.VITE_SOURCE_CODE_URL || "https://github.com/HaD0Yun/CozyClay";

/** The network-source offer required by AGPLv3 section 13. */
export default function SourceOffer() {
	return (
		<a className="source-offer" href={SOURCE_URL} target="_blank" rel="noreferrer">
			Source code (AGPL)
		</a>
	);
}
