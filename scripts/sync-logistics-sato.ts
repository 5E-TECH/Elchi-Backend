import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Region } from '../apps/logistics-service/src/entities/region.entity';
import { District } from '../apps/logistics-service/src/entities/district.entity';
import { satoCodes } from '../apps/logistics-service/src/data/sato-codes.data';

dotenv.config({ path: '.env.production', override: true });

const postgresUri = process.env.POSTGRES_URI;
if (!postgresUri) {
  throw new Error('POSTGRES_URI is required for sync-logistics-sato');
}

const dataSource = new DataSource({
  type: 'postgres',
  url: postgresUri,
  schema: 'logistics_schema',
  entities: [Region, District],
  synchronize: false,
  logging: false,
});

function normalizeRegionName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+viloyati$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDistrictName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+tumani$/i, '')
    .replace(/\s+shahri$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toProjectRegionName(sourceName: string): string {
  return sourceName.replace(/\s+viloyati$/i, '').trim();
}

async function upsertRegion(
  regionRepo: DataSource['manager'],
  name: string,
  satoCode: string,
): Promise<Region> {
  const normalized = normalizeRegionName(name);
  const normalizedProjectName = toProjectRegionName(name);

  const byCode = await regionRepo.findOne(Region, { where: { sato_code: satoCode } });
  if (byCode) {
    if (byCode.name !== normalizedProjectName) {
      byCode.name = normalizedProjectName;
      await regionRepo.save(Region, byCode);
    }
    return byCode;
  }

  const allRegions = await regionRepo.find(Region);
  const byName = allRegions.find(
    (region) => normalizeRegionName(region.name) === normalized,
  );

  if (byName) {
    byName.sato_code = satoCode;
    if (byName.name !== normalizedProjectName) {
      byName.name = normalizedProjectName;
    }
    return regionRepo.save(Region, byName);
  }

  const created = regionRepo.create(Region, {
    name: normalizedProjectName,
    sato_code: satoCode,
  });
  return regionRepo.save(Region, created);
}

async function upsertDistrict(
  manager: DataSource['manager'],
  region: Region,
  districtName: string,
  districtSatoCode: string,
): Promise<void> {
  const normalized = normalizeDistrictName(districtName);

  const byCode = await manager.findOne(District, {
    where: { sato_code: districtSatoCode },
  });
  if (byCode) {
    byCode.region_id = region.id;
    byCode.assigned_region = byCode.assigned_region ?? region.id;
    if (normalizeDistrictName(byCode.name) !== normalized) {
      byCode.name = districtName;
    }
    await manager.save(District, byCode);
    return;
  }

  const existingInRegion = await manager.find(District, {
    where: { region_id: region.id },
  });
  const byName = existingInRegion.find(
    (district) => normalizeDistrictName(district.name) === normalized,
  );

  if (byName) {
    byName.sato_code = districtSatoCode;
    byName.assigned_region = byName.assigned_region ?? region.id;
    if (byName.name !== districtName) {
      byName.name = districtName;
    }
    await manager.save(District, byName);
    return;
  }

  const created = manager.create(District, {
    name: districtName,
    sato_code: districtSatoCode,
    region_id: region.id,
    assigned_region: region.id,
  });
  await manager.save(District, created);
}

async function main(): Promise<void> {
  await dataSource.initialize();
  try {
    const manager = dataSource.manager;

    let regionUpdated = 0;
    let districtUpdated = 0;

    for (const sourceRegion of satoCodes) {
      const region = await upsertRegion(
        manager,
        sourceRegion.name,
        sourceRegion.sato_code,
      );
      regionUpdated += 1;

      for (const sourceDistrict of sourceRegion.districts) {
        await upsertDistrict(
          manager,
          region,
          sourceDistrict.name,
          sourceDistrict.sato_code,
        );
        districtUpdated += 1;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[sync-logistics-sato] done: regions=${regionUpdated}, districts=${districtUpdated}`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[sync-logistics-sato] failed:', error);
  process.exit(1);
});
