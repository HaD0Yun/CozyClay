// The Content browser's "All" view: every folder's tiles on one scroll, each
// under a small heading, so a handful of assets is not split across seven
// folders. Folders with nothing to place drop out (asset-pane.css hides a
// section without tiles); a search filters every section at once. `Grid` is
// the pane's FolderGrid, passed in so this file needs no import cycle.
import { ko } from "./locale.js";
import { SearchEmpty } from "./search-friction.js";

export function AllFolders({ folders, Grid, query, ...props }) {
	return (
		<div className="content-all" data-testid="content-all">
			{folders.map((entry) => (
				<section key={entry.id} className="content-all-section" data-folder={entry.id} aria-label={entry.label()}>
					<h3 className="content-all-head">{entry.label()}</h3>
					<Grid folder={entry.id} query={query} {...props} />
				</section>
			))}
			{query ? <SearchEmpty surface="assets" query={query}><p className="content-empty content-all-none">{ko("Nothing matches this search.", "검색 결과가 없어요.")}</p></SearchEmpty> : null}
		</div>
	);
}
