import type { Migration } from './types';

export const predictionEvidenceMigration: Migration = {
  id: '008-prediction-evidence',
  description: 'Store each prediction\'s evidence parts, and link a review cut from another to its source',
  up: (db) => {
    db.exec(`
      ALTER TABLE prediction_reviews ADD COLUMN predicted_parts_json TEXT;
      ALTER TABLE prediction_reviews ADD COLUMN split_from_review_id INTEGER;
    `);
  }
};
