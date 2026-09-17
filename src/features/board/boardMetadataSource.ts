/**
 * Public feature-level name for the shared Board metadata source.
 * Keep the implementation in `metadataSource.ts` so existing feature tests
 * and imports remain stable while the B3 boundary has an explicit entrypoint.
 */
export {
  boardMetadataSource,
  createBoardMetadataSource,
  type BoardMetadataSource,
} from './metadataSource'
