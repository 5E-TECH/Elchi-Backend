import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RpcException } from '@nestjs/microservices';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';
import { regions } from './data/regions-districts.data';
import { CreateDistrictDto } from './dto/create-district.dto';
import { UpdateDistrictDto } from './dto/update-district.dto';
import { UpdateDistrictNameDto } from './dto/update-district-name.dto';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { errorRes, successRes } from '../../../libs/common/helpers/response';

@Injectable()
export class LogisticsServiceService implements OnModuleInit {
  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Region) private readonly regionRepo: Repository<Region>,
    @InjectRepository(District) private readonly districtRepo: Repository<District>,
  ) {}

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  async onModuleInit() {
    for (const [regionIndex, regionData] of regions.entries()) {
      const regionName = regionData.name.trim();
      let regionEntity = await this.regionRepo.findOne({
        where: { name: regionName },
      });

      if (!regionEntity) {
        const generatedSato = `REG-${String(regionIndex + 1).padStart(2, '0')}`;
        let satoCode = generatedSato;
        const satoExists = await this.regionRepo.findOne({
          where: { sato_code: generatedSato },
        });
        if (satoExists) {
          satoCode = `${generatedSato}-${Date.now()}`;
        }

        regionEntity = await this.regionRepo.save(
          this.regionRepo.create({
            name: regionName,
            sato_code: satoCode,
          }),
        );
      }

      for (const [districtIndex, districtNameRaw] of regionData.districts.entries()) {
        const districtName = districtNameRaw.trim();
        const exists = await this.districtRepo.findOne({
          where: { name: districtName, region_id: regionEntity.id },
        });

        if (exists) {
          continue;
        }

        const district = this.districtRepo.create({
          name: districtName,
          sato_code: `REG-${String(regionIndex + 1).padStart(2, '0')}-DIS-${String(districtIndex + 1).padStart(2, '0')}`,
          region_id: regionEntity.id,
          assigned_region: regionEntity.id,
        });
        await this.districtRepo.save(district);
      }
    }
  }

  async createDistrict(dto: CreateDistrictDto) {
    const region = await this.regionRepo.findOne({ where: { id: dto.region_id } });
    if (!region) {
      this.notFound('Region not found');
    }

    const exists = await this.districtRepo.findOne({
      where: { name: dto.name.trim(), region_id: dto.region_id },
    });
    if (exists) {
      this.conflict('District already exists in this region');
    }

    const district = this.districtRepo.create({
      name: dto.name.trim(),
      sato_code: '',
      region_id: dto.region_id,
      assigned_region: dto.region_id,
    });
    const saved = await this.districtRepo.save(district);
    return successRes(saved, 201, 'New district added');
  }

  async findAllDistricts() {
    const districts = await this.districtRepo.find({
      relations: ['region', 'assignedToRegion'],
      order: { createdAt: 'DESC' },
    });
    return successRes(districts);
  }

  async findDistrictById(id: string) {
    const district = await this.districtRepo.findOne({
      where: { id },
      relations: ['region', 'assignedToRegion'],
    });
    if (!district) {
      this.notFound('District not found');
    }
    return successRes(district);
  }

  async updateDistrict(id: string, dto: UpdateDistrictDto) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    if (district.assigned_region === dto.assigned_region) {
      this.badRequest('The district already assigned to this region');
    }

    const assigningRegion = await this.regionRepo.findOne({
      where: { id: dto.assigned_region },
    });
    if (!assigningRegion) {
      this.notFound('The region you are trying to assign does not exist');
    }

    district.assigned_region = assigningRegion.id;
    district.assignedToRegion = assigningRegion;

    const saved = await this.districtRepo.save(district);
    return successRes(saved, 200, 'District assigned to new region');
  }

  async updateDistrictName(id: string, dto: UpdateDistrictNameDto) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    const trimmedName = dto.name.trim();
    if (!trimmedName) {
      this.badRequest('District name is required');
    }

    const duplicate = await this.districtRepo.findOne({
      where: { name: trimmedName, region_id: district.region_id },
    });
    if (duplicate && duplicate.id !== district.id) {
      this.conflict('District name already exists in this region');
    }

    district.name = trimmedName;
    await this.districtRepo.save(district);
    return successRes({}, 200, 'District name updated');
  }

  async deleteDistrict(id: string) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    await this.districtRepo.remove(district);
    return successRes({ id }, 200, 'District deleted');
  }

  async createRegion(dto: CreateRegionDto) {
    const name = dto.name.trim();
    const satoCode = dto.sato_code.trim();

    if (!name || !satoCode) {
      this.badRequest('name and sato_code are required');
    }

    const existingByName = await this.regionRepo.findOne({ where: { name } });
    if (existingByName) {
      this.conflict('Region name already exists');
    }

    const existingBySato = await this.regionRepo.findOne({
      where: { sato_code: satoCode },
    });
    if (existingBySato) {
      this.conflict('Region sato_code already exists');
    }

    const region = this.regionRepo.create({ name, sato_code: satoCode });
    const saved = await this.regionRepo.save(region);
    return successRes(saved, 201, 'Region created');
  }

  async findAllRegions() {
    const rows = await this.regionRepo.find({
      relations: ['districts'],
      order: { createdAt: 'DESC' },
    });
    return successRes(rows);
  }

  async findRegionById(id: string) {
    const region = await this.regionRepo.findOne({
      where: { id },
      relations: ['districts'],
    });
    if (!region) {
      this.notFound('Region not found');
    }
    return successRes(region);
  }

  async updateRegion(id: string, dto: UpdateRegionDto) {
    const region = await this.regionRepo.findOne({ where: { id } });
    if (!region) {
      this.notFound('Region not found');
    }

    if (typeof dto.name !== 'undefined') {
      const nextName = dto.name.trim();
      if (!nextName) {
        this.badRequest('name cannot be empty');
      }
      const existing = await this.regionRepo.findOne({ where: { name: nextName } });
      if (existing && existing.id !== id) {
        this.conflict('Region name already exists');
      }
      region.name = nextName;
    }

    if (typeof dto.sato_code !== 'undefined') {
      const nextSato = dto.sato_code.trim();
      if (!nextSato) {
        this.badRequest('sato_code cannot be empty');
      }
      const existing = await this.regionRepo.findOne({
        where: { sato_code: nextSato },
      });
      if (existing && existing.id !== id) {
        this.conflict('Region sato_code already exists');
      }
      region.sato_code = nextSato;
    }

    const saved = await this.regionRepo.save(region);
    return successRes(saved, 200, 'Region updated');
  }

  async deleteRegion(id: string) {
    const region = await this.regionRepo.findOne({ where: { id } });
    if (!region) {
      this.notFound('Region not found');
    }

    await this.regionRepo.remove(region);
    return successRes({ id }, 200, 'Region deleted');
  }

  // TODO: Post CRUD
}
