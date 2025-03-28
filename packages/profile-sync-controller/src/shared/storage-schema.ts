import { createSHA256Hash } from './encryption';

/**
 * The User Storage Endpoint requires a feature name and a namespace key.
 * Developers can provide additional features and keys by extending these types below.
 *
 * Adding ALLOW_ARBITRARY_KEYS as the first key in the array allows for any key to be used for this feature.
 * This can be useful for features where keys are not deterministic (eg. accounts addresses).
 */
const ALLOW_ARBITRARY_KEYS = 'ALLOW_ARBITRARY_KEYS' as const;

export const USER_STORAGE_FEATURE_NAMES = {
  notifications: 'notifications',
  accounts: 'accounts_v2',
  networks: 'networks',
} as const;

export type UserStorageFeatureNames =
  (typeof USER_STORAGE_FEATURE_NAMES)[keyof typeof USER_STORAGE_FEATURE_NAMES];

export const USER_STORAGE_SCHEMA = {
  [USER_STORAGE_FEATURE_NAMES.notifications]: ['notification_settings'],
  [USER_STORAGE_FEATURE_NAMES.accounts]: [ALLOW_ARBITRARY_KEYS], // keyed by account addresses
  [USER_STORAGE_FEATURE_NAMES.networks]: [ALLOW_ARBITRARY_KEYS], // keyed by chains/networks
} as const;

type UserStorageSchema = typeof USER_STORAGE_SCHEMA;

export type UserStorageFeatureKeys<Feature extends UserStorageFeatureNames> =
  UserStorageSchema[Feature][0] extends typeof ALLOW_ARBITRARY_KEYS
    ? string
    : UserStorageSchema[Feature][number];

type UserStorageFeatureAndKey = {
  feature: UserStorageFeatureNames;
  key: UserStorageFeatureKeys<UserStorageFeatureNames>;
};

export type UserStoragePathWithFeatureOnly = UserStorageFeatureNames;
export type UserStoragePathWithFeatureAndKey = {
  [K in UserStorageFeatureNames]: `${K}.${UserStorageFeatureKeys<K>}`;
}[UserStoragePathWithFeatureOnly];

export const getFeatureAndKeyFromPath = (
  path: UserStoragePathWithFeatureAndKey,
): UserStorageFeatureAndKey => {
  const pathRegex = /^\w+\.\w+$/u;

  if (!pathRegex.test(path)) {
    throw new Error(
      `user-storage - path is not in the correct format. Correct format: 'feature.key'`,
    );
  }

  const [feature, key] = path.split('.') as [
    UserStorageFeatureNames,
    UserStorageFeatureKeys<UserStorageFeatureNames>,
  ];

  if (!(feature in USER_STORAGE_SCHEMA)) {
    throw new Error(`user-storage - invalid feature provided: ${feature}`);
  }

  const validFeature = USER_STORAGE_SCHEMA[feature] as readonly string[];

  if (
    !validFeature.includes(key) &&
    !validFeature.includes(ALLOW_ARBITRARY_KEYS)
  ) {
    const validKeys = USER_STORAGE_SCHEMA[feature].join(', ');

    throw new Error(
      `user-storage - invalid key provided for this feature: ${key}. Valid keys: ${validKeys}`,
    );
  }

  return { feature, key };
};

export const isPathWithFeatureAndKey = (
  path: string,
): path is UserStoragePathWithFeatureAndKey => {
  const pathRegex = /^\w+\.\w+$/u;

  return pathRegex.test(path);
};

/**
 * Constructs a unique entry path for a user.
 * This can be done due to the uniqueness of the storage key (no users will share the same storage key).
 * The users entry is a unique hash that cannot be reversed.
 *
 * @param path - string in the form of `${feature}.${key}` that matches schema
 * @param storageKey - users storage key
 * @returns path to store entry
 */
export function createEntryPath(
  path: UserStoragePathWithFeatureAndKey,
  storageKey: string,
): string {
  const { feature, key } = getFeatureAndKeyFromPath(path);
  const hashedKey = createSHA256Hash(key + storageKey);

  return `${feature}/${hashedKey}`;
}
