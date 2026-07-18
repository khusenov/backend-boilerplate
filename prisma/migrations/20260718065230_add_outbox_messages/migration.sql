-- CreateTable
CREATE TABLE `outbox_messages` (
    `id` CHAR(36) NOT NULL,
    `aggregate_id` CHAR(36) NOT NULL,
    `event_name` VARCHAR(255) NOT NULL,
    `payload` TEXT NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `published_at` DATETIME(3) NULL,

    INDEX `outbox_messages_published_at_occurred_at_idx`(`published_at`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
