import { UNLOADED, LOADED, FAILED } from './constants.js';

function isDownloadFinished( value ) {

	return value === LOADED || value === FAILED;

}

function priorityFunction ( a, b ) {

	if ( a.__inFrustum !== b.__inFrustum ) {

		return a.__inFrustum ? 1 : - 1;

	} 
	else if ( a.__distanceFromCamera !== b.__distanceFromCamera ) {

		return a.__distanceFromCamera > b.__distanceFromCamera ? - 1 : 1;

	}
	else if (a._foveatedFactor !== b._foveatedFactor) {

		return a._foveatedFactor > b._foveatedFactor ? -1 : 1;
	}

	return 0;

}

// Checks whether this tile was last used on the given frame.
function isUsedThisFrame( tile, frameCount ) {

	return tile.__lastFrameVisited === frameCount && tile.__used;

}

// Resets the frame frame information for the given tile
function resetFrameState( tile, frameCount ) {

	if ( tile.__lastFrameVisited !== frameCount ) {

		tile.__lastFrameVisited = frameCount;
		tile.__used = false;
		tile.__inFrustum = false;
		tile.__isLeaf = false;
		tile.__visible = false;
		tile.__active = false;
		tile.__error = Infinity;
		tile.__distanceFromCamera = Infinity;
		tile.__childrenWereVisible = false;
		tile.__allChildrenLoaded = false;

	}

}

// Recursively mark tiles used down to the next tile with content
function recursivelyMarkUsed( tile, frameCount, lruCache ) {

	resetFrameState( tile, frameCount );

	tile.__used = true;
	lruCache.markUsed( tile );
	if ( tile.__contentEmpty ) {

		const children = tile.children;
		for ( let i = 0, l = children.length; i < l; i ++ ) {

			recursivelyMarkUsed( children[ i ], frameCount, lruCache );

		}

	}

}

function recursivelyLoadTiles( tile, depthFromRenderedParent, renderer ) {

	// Try to load any external tile set children if the external tile set has loaded.
	const doTraverse =
		tile.__contentEmpty && (
			! tile.__externalTileSet ||
			isDownloadFinished( tile.__loadingState )
		);
	if ( doTraverse ) {

		const children = tile.children;
		for ( let i = 0, l = children.length; i < l; i ++ ) {

			// don't increment depth to rendered parent here because we should treat
			// the next layer of rendered children as just a single depth away for the
			// sake of sorting.
			const child = children[ i ];
			child.__depthFromRenderedParent = depthFromRenderedParent;
			recursivelyLoadTiles( child, depthFromRenderedParent, renderer );

		}

	} else {

		renderer.requestTileContents( tile );

	}

}

// Helper function for recursively traversing a tile set. If `beforeCb` returns `true` then the
// traversal will end early.
export function traverseSet( tile, beforeCb = null, afterCb = null, parent = null, depth = 0 ) {

	if ( beforeCb && beforeCb( tile, parent, depth ) ) {

		if ( afterCb ) {

			afterCb( tile, parent, depth );

		}

		return;

	}

	const children = tile.children;
	for ( let i = 0, l = children.length; i < l; i ++ ) {

		traverseSet( children[ i ], beforeCb, afterCb, tile, depth + 1 );

	}

	if ( afterCb ) {

		afterCb( tile, parent, depth );

	}

}

// Determine which tiles are within the camera frustum.
// TODO: this is marking items as used in the lrucache, which means some data is
// being kept around that isn't being used -- is that okay?
export function determineFrustumSet(tile, renderer) {

	const stats = renderer.stats;
	const frameCount = renderer.frameCount;
	const errorTarget = renderer.errorTarget;
	const maxDepth = renderer.maxDepth;
	const loadSiblings = renderer.loadSiblings;
	const lruCache = renderer.lruCache;
	const stopAtEmptyTiles = renderer.stopAtEmptyTiles;
	const enabledSchedule = renderer.enabledSchedule;
	const cullWithChildrenBounds = renderer.cullWithChildrenBounds;
	resetFrameState(tile, frameCount);

	const inFrustum = renderer.tileInView(tile);
	if (inFrustum === false) {
	
		return false;
	
	}

	tile.__used = true;
	lruCache.markUsed(tile);

	tile.__inFrustum = true;
	stats.inFrustum++;

	// 结束case
	if ((stopAtEmptyTiles || !tile.__contentEmpty) && (!tile.__externalTileSet)) {
		renderer.calculateError(tile);

		const error = tile.__error;
		if (error <= errorTarget) {
			return true;
		}

		if (renderer.maxDepth > 0 && tile.__depth + 1 >= maxDepth) {
			return true;
		}
	}

	/** start */
	if (tile.__externalTileSet && !isDownloadFinished(tile.__loadingState) && enabledSchedule) {

		renderer.requestTileContents(tile);

	}
	/** end */

	// 遍历子级
	let anyChildrenUsed = false;
	const children = tile.children;
	for (let i = 0; i < children.length; i++) {
		const c = children[i];

		if (tile.__externalTileSet && !isDownloadFinished(tile.__loadingState) && enabledSchedule) {

			renderer.requestTileContents(tile);
	
		}
	
		const r = determineFrustumSet(c, renderer);
		anyChildrenUsed = anyChildrenUsed || r;
	}

	if (anyChildrenUsed && loadSiblings) {

		for (let  i = 0; i < children.length; i++) {

			const c = children[i]
			recursivelyMarkUsed(c, frameCount, lruCache);
	
			/** start */
			if (!c.__inFrustum && enabledSchedule) {
				const isExternalTileSet = c.__externalTileSet;
				isExternalTileSet && renderer.requestTileContents(c);
			}
			/** end */
		}

	}

	if ( cullWithChildrenBounds && !anyChildrenUsed && children.length > 0 && tile.refine === 'REPLACE' && tile.__inFrustum) {
		tile.__inFrustum = false;
		stats.inFrustum ++;

		return false;
	}

	return true;

}

// Traverse and mark the tiles that are at the leaf nodes of the "used" tree.
export function markUsedSetLeaves( tile, renderer ) {

	const stats = renderer.stats;
	const frameCount = renderer.frameCount;
	const enabledSchedule = renderer.enabledSchedule;
	const deferOutSideFrustum = renderer.deferOutSideFrustum;

	if ( ! isUsedThisFrame( tile, frameCount ) ) {

		return;

	}

	stats.used ++;

	// This tile is a leaf if none of the children had been used.
	const children = tile.children
	let anyChildrenUsed = false;
	for ( let i = 0, l = children.length; i < l; i ++ ) {

		const c = children[ i ];
		anyChildrenUsed = anyChildrenUsed || isUsedThisFrame( c, frameCount );

	}


	if ( ! anyChildrenUsed) {

		// TODO: This isn't necessarily right because it's possible that a parent tile is considered in the
		// frustum while the child tiles are not, making them unused. If all children have loaded and were properly
		// considered to be in the used set then we shouldn't set ourselves to a leaf here.
		tile.__isLeaf = true;

	} else {

		let childrenWereVisible = false;
		let allChildrenLoaded = true;
		for ( let i = 0, l = children.length; i < l; i ++ ) {

			const c = children[ i ];
			markUsedSetLeaves( c, renderer );
			childrenWereVisible = childrenWereVisible || c.__wasSetVisible || c.__childrenWereVisible;

			// 如果开启了调度加载，只需要去判断视窗内的瓦片是否全部加载
			if (enabledSchedule && deferOutSideFrustum) {
				if (c.__inFrustum) {
					const childrenLoaded = c.__allChildrenLoaded
					|| (!c.__contentEmpty && isDownloadFinished(c.__loadingState))
					|| (c.__externalTileSet && c.__loadingState === FAILED);
	
					allChildrenLoaded = allChildrenLoaded && childrenLoaded;
				}
			}
			else if ( isUsedThisFrame(c, frameCount) ) {

				const childrenLoaded = c.__allChildrenLoaded
				|| (!c.__contentEmpty && isDownloadFinished(c.__loadingState))
				|| (c.__externalTileSet && c.__loadingState === FAILED);

				allChildrenLoaded = allChildrenLoaded && childrenLoaded;

			}

		}
		tile.__childrenWereVisible = childrenWereVisible;
		tile.__allChildrenLoaded = allChildrenLoaded;

	}

}

function traversalAndCacheTiles( tile, renderer ) {

	const maxJobs = renderer.downloadQueue.maxJobs;
	const stats = renderer.stats;
	const cacheDepth = renderer.cacheDepth;
	const lruCache = renderer.lruCache;
	const maxCacheChildren = renderer.maxCacheChildren;

	if ( lruCache.cacheList.length >= maxCacheChildren ) {

		return;

	}

	// 强缓存标志 
	lruCache.markCache( tile );

	if ( tile.__depth >= cacheDepth ) {

		return;

	}

	const children = tile.children || [];
	for ( let i = 0; i < children.length; i++ ) {

		const c = children[i];
		const hasContent = ! c.__contentEmpty || c.__externalTileSet;

		if ( hasContent && !isDownloadFinished(c.__loadingState) && stats.downloading < maxJobs * 3 / 4 ) {

			renderer.requestTileContents( c );

		}

		traversalAndCacheTiles( c, renderer );

	}

}

export function requestPriorityTiles(tile, renderer) {

	const frameCount = renderer.frameCount;
	const stats = renderer.stats;
	const deferOutSideFrustum = renderer.deferOutSideFrustum;
	const deferLoadDepth = renderer.deferLoadDepth;
	const maxJobs = renderer.downloadQueue.maxJobs;

	if (!isUsedThisFrame( tile, frameCount )) {

		return;

	}

	const deferQueue = [];
	const tileStack = [];
	tileStack.push(tile);

	let depth = 0;
	while(tileStack.length > 0) {
		const selectedTile = tileStack.pop();

		if (!isUsedThisFrame(selectedTile, frameCount)) {

			continue;

		}

		let contentTiles = selectedTile.contentChildren || [];

		contentTiles.sort(priorityFunction);

		let usedTiles = contentTiles.filter(item => isUsedThisFrame(item, frameCount));

		if (deferOutSideFrustum) {

			const inFrustumTiles = usedTiles.filter(item => item.__inFrustum);
			const outFrustumTiles = usedTiles.filter(item => !item.__inFrustum);
			const unloadOutFrustumTiles = outFrustumTiles.filter(item => !isDownloadFinished(item.__loadingState));
			if (unloadOutFrustumTiles.length > 0) {
				depth ++;
			}

			usedTiles = inFrustumTiles;
			deferQueue.push(...unloadOutFrustumTiles);

		}

		const unloadedChildren = usedTiles.filter( item => !isDownloadFinished(item.__loadingState) );

		if (unloadedChildren.length > 0) {
			unloadedChildren.forEach(item => {
				renderer.requestTileContents( item );
			});

			if (stats.downloading >= maxJobs * 3 / 4) {
				break;
			}
		}

		if (depth > deferLoadDepth && deferOutSideFrustum) {

			break;

		}

		const allChildrenTiles = selectedTile.children;
		allChildrenTiles.sort(priorityFunction)

		tileStack.push(...allChildrenTiles.reverse());
	}

	// 若当前加载队列还比较空闲可以加载不在视锥体内的瓦片
	while((stats.downloading < maxJobs * 3 / 4) && deferQueue.length > 0) {
		const deferTile = deferQueue.shift();
		renderer.requestTileContents(deferTile);
	}

	if (stats.downloading < maxJobs * 1 / 2) {

		traversalAndCacheTiles(tile, renderer);

	}

}

// Skip past tiles we consider unrenderable because they are outside the error threshold.
export function skipTraversal( tile, renderer ) {

	const stats = renderer.stats;
	const frameCount = renderer.frameCount;
	const enabledSchedule = renderer.enabledSchedule;

	if ( ! isUsedThisFrame( tile, frameCount ) ) {

		return;

	}

	const parent = tile.parent;
	const parentDepthToParent = parent ? parent.__depthFromRenderedParent : - 1;
	tile.__depthFromRenderedParent = parentDepthToParent;

	// Request the tile contents or mark it as visible if we've found a leaf.
	const lruCache = renderer.lruCache;
	if ( tile.__isLeaf ) {

		tile.__depthFromRenderedParent ++;

		if ( tile.__loadingState === LOADED ) {

			if ( tile.__inFrustum ) {

				tile.__visible = true;
				stats.visible ++;

			}
			tile.__active = true;
			stats.active ++;

		} else if ( ! enabledSchedule && ! lruCache.isFull() && ( ! tile.__contentEmpty || tile.__externalTileSet ) ) {

			renderer.requestTileContents( tile );

		}

		return;

	}

	const errorRequirement = ( renderer.errorTarget + 1 ) * renderer.errorThreshold;
	const meetsSSE = tile.__error <= errorRequirement;
	const includeTile = meetsSSE || tile.refine === 'ADD';
	const hasModel = ! tile.__contentEmpty;
	const hasContent = hasModel || tile.__externalTileSet;
	const loadedContent = isDownloadFinished( tile.__loadingState ) && hasContent;
	const childrenWereVisible = tile.__childrenWereVisible;
	const children = tile.children;
	const allChildrenHaveContent = tile.__allChildrenLoaded;

	// Increment the relative depth of the node to the nearest rendered parent if it has content
	// and is being rendered.
	if ( includeTile && hasModel ) {

		tile.__depthFromRenderedParent ++;

	}

	// If we've met the SSE requirements and we can load content then fire a fetch.
	if ( ! enabledSchedule && includeTile && ! loadedContent && ! lruCache.isFull() && hasContent) {

		renderer.requestTileContents( tile );

	}

	if (
		( enabledSchedule && meetsSSE && ! allChildrenHaveContent && loadedContent )
		    || ( !enabledSchedule && meetsSSE && ! allChildrenHaveContent && ! childrenWereVisible && loadedContent )
			|| ( tile.refine === 'ADD' && loadedContent )
	) {

		if ( tile.__inFrustum ) {

			tile.__visible = true;
			stats.visible ++;

		}
		tile.__active = true;
		stats.active ++;

	}

	// If we're additive then don't stop the traversal here because it doesn't matter whether the children load in
	// at the same rate.
	if ( tile.refine !== 'ADD' && meetsSSE && ! allChildrenHaveContent && loadedContent ) {

		// load the child content if we've found that we've been loaded so we can move down to the next tile
		// layer when the data has loaded.
		for ( let i = 0, l = children.length; (i < l && ! enabledSchedule); i ++ ) {

			const c = children[ i ];
			if ( isUsedThisFrame( c, frameCount ) && ! lruCache.isFull() ) {

				c.__depthFromRenderedParent = tile.__depthFromRenderedParent + 1;
				recursivelyLoadTiles( c, c.__depthFromRenderedParent, renderer );

			}

		}

	} else {

		for ( let i = 0, l = children.length; (i < l ); i ++ ) {

			const c = children[ i ];
			skipTraversal( c, renderer );

		}

	}

}

// Final traverse to toggle tile visibility.
export function toggleTiles( tile, renderer ) {

	const frameCount = renderer.frameCount;
	const isUsed = isUsedThisFrame( tile, frameCount );
	if ( isUsed || tile.__usedLastFrame ) {

		let setActive = false;
		let setVisible = false;
		if ( isUsed ) {

			// enable visibility if active due to shadows
			setActive = tile.__active;
			if ( renderer.displayActiveTiles ) {

				setVisible = tile.__active || tile.__visible;

			} else {

				setVisible = tile.__visible;

			}

		}

		// If the active or visible state changed then call the functions.
		if ( ! tile.__contentEmpty && tile.__loadingState === LOADED ) {

			if ( tile.__wasSetActive !== setActive ) {

				renderer.setTileActive( tile, setActive );

			}

			if ( tile.__wasSetVisible !== setVisible ) {

				renderer.setTileVisible( tile, setVisible );

			}

		}
		tile.__wasSetActive = setActive;
		tile.__wasSetVisible = setVisible;
		tile.__usedLastFrame = isUsed;

		const children = tile.children;
		for ( let i = 0, l = children.length; i < l; i ++ ) {

			const c = children[ i ];
			toggleTiles( c, renderer );

		}

	}

}

// TODO - add support for regions?
// whether children bounds are fully contained within the paren
export function checkChildrenWithinParent( tile ) {

	const children = tile.children;
	const length = children.length;

	const { absoluteBox } = tile.cached;

	if ( absoluteBox ) {

		tile._useOptimization = true;
		for ( let i = 0; i < length; i ++ ) {

			const child = children[ i ];
			const { absoluteBox: childAbsoluteBox } = child;
			if ( ! ( childAbsoluteBox ) ) {

				tile._useOptimization = false;
				break;

			}

			const { x: minX, y: minY, z: minZ } = absoluteBox.min;
			const { x: maxX, y: maxY, z: maxZ } = absoluteBox.max;

			const { x: childMinX, y: childMinY, z: childMinZ } = childAbsoluteBox;
			const { x: childMaxX, y: childMaxY, z: childMaxZ } = childAbsoluteBox;

			if ( ( minX > childMinX ) || ( minY > childMinY ) || ( minZ > childMinZ )
				|| ( maxX < childMaxX ) || ( maxY < childMaxY ) || ( maxZ < childMaxZ )
			) {

				tile._useOptimization = false;
				break;

			}

		}

	}

	return tile._useOptimization === true;

}

function findNearestContentTile(tile, parent = tile, isSelf = true, depth = 0, depthContentTiles = {},) {

	const hasModel = ! tile.__contentEmpty;
	const isExternalTileSet = tile.__externalTileSet;

	if ( hasModel && !isSelf ) {

		depthContentTiles[depth] ? depthContentTiles[depth].push(tile) : depthContentTiles[depth] = [tile];

	}
	else {

		depth ++;

		const children = tile.children;
		for (let i = 0, l = children.length; i < l; i++) {

			const c = children[i];
	
			const contentChildren = findNearestContentTile(c, parent, false, depth, depthContentTiles);

			if ( isExternalTileSet ) {

				for ( let j = 0; j < contentChildren.length; j++ ) {

					const contentChild = contentChildren[j];
					tile.__distanceFromCamera = Math.min( tile.__distanceFromCamera, contentChild.__distanceFromCamera );
					
				}

			}

		}

	}

	const keys = Object.keys(depthContentTiles);
	const firstKey = keys[0];
	let contentTiles = [];

	if (keys[0]) {

		contentTiles = depthContentTiles[firstKey];

	}

	return contentTiles;
}

export function buildContentTree(tile, renderer) {

	const frameCount = renderer.frameCount;

	if ( ! isUsedThisFrame( tile, frameCount ) ) {

		return;

	}

	if (!tile.parent) {

		tile.contentChildren = findNearestContentTile( tile );

	}

	const children = tile.children;

	for (let i = 0; i < children.length; i++) {
		
		const c = children[i];

		c.contentChildren = findNearestContentTile(c);
		buildContentTree(c, renderer);

	}

}