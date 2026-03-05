-- Migration: Standardize soft delete column naming
-- All entities now use "isDeleted" (camelCase) via BaseEntity
-- Run this BEFORE deploying the new code

-- Order service: "deleted" -> "isDeleted"
ALTER TABLE order_schema.orders RENAME COLUMN deleted TO "isDeleted";

-- Identity service: "is_deleted" -> "isDeleted"
ALTER TABLE identity_schema.admins RENAME COLUMN is_deleted TO "isDeleted";
