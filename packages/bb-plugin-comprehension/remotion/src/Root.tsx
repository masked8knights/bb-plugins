import { Composition } from "remotion";
import {
  ComprehensionBrief,
  DURATION_IN_FRAMES,
  FPS,
  HEIGHT,
  WIDTH,
} from "./Video";
import {ComprehensionPodcast, PODCAST_DURATION_IN_FRAMES} from "./Podcast";

export const Root = () => (
  <>
    <Composition
      id="ComprehensionBrief"
      component={ComprehensionBrief}
      durationInFrames={DURATION_IN_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
    <Composition
      id="ComprehensionPodcast"
      component={ComprehensionPodcast}
      durationInFrames={PODCAST_DURATION_IN_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  </>
);
