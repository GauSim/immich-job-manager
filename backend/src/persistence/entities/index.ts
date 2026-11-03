import { AssetFeatureEntity } from './asset-feature.entity.js';
import { AssetIndexEntity } from './asset-index.entity.js';
import { JobAssetEntity } from './job-asset.entity.js';
import {
  JobGroupAssetEntity,
  JobGroupEntity,
  RunGroupEntity,
} from './job-group.entity.js';
import { JobRunEntity } from './job-run.entity.js';
import { JobEntity } from './job.entity.js';
import { RunCandidateEntity } from './run-candidate.entity.js';
import { RunLogEntity } from './run-log.entity.js';
import { SettingEntity } from './setting.entity.js';

export * from './asset-feature.entity.js';
export * from './asset-index.entity.js';
export * from './job-asset.entity.js';
export * from './job-group.entity.js';
export * from './job-run.entity.js';
export * from './job.entity.js';
export * from './run-candidate.entity.js';
export * from './run-log.entity.js';
export * from './setting.entity.js';

export const ENTITIES = [
  JobEntity,
  JobRunEntity,
  RunCandidateEntity,
  JobAssetEntity,
  AssetFeatureEntity,
  AssetIndexEntity,
  JobGroupEntity,
  JobGroupAssetEntity,
  RunGroupEntity,
  RunLogEntity,
  SettingEntity,
];
