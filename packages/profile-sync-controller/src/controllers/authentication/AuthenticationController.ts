import type {
  ControllerGetStateAction,
  ControllerStateChangeEvent,
  RestrictedControllerMessenger,
  StateMetadata,
} from '@metamask/base-controller';
import { BaseController } from '@metamask/base-controller';
import type {
  KeyringControllerGetStateAction,
  KeyringControllerLockEvent,
  KeyringControllerUnlockEvent,
} from '@metamask/keyring-controller';
import type { HandleSnapRequest } from '@metamask/snaps-controllers';

import {
  createSnapPublicKeyRequest,
  createSnapSignMessageRequest,
} from './auth-snap-requests';
import {
  createLoginRawMessage,
  getAccessToken,
  getNonce,
  login,
} from './services';

const THIRTY_MIN_MS = 1000 * 60 * 30;

const controllerName = 'AuthenticationController';

// State
type SessionProfile = {
  identifierId: string;
  profileId: string;
};

type SessionData = {
  /** profile - anonymous profile data for the given logged in user */
  profile: SessionProfile;
  /** accessToken - used to make requests authorized endpoints */
  accessToken: string;
  /** expiresIn - string date to determine if new access token is required  */
  expiresIn: string;
};

type MetaMetricsAuth = {
  getMetaMetricsId: () => string | Promise<string>;
  agent: 'extension' | 'mobile';
};

export type AuthenticationControllerState = {
  /**
   * Global isSignedIn state.
   * Can be used to determine if "Profile Syncing" is enabled.
   */
  isSignedIn: boolean;
  sessionData?: SessionData;
};
export const defaultState: AuthenticationControllerState = {
  isSignedIn: false,
};
const metadata: StateMetadata<AuthenticationControllerState> = {
  isSignedIn: {
    persist: true,
    anonymous: true,
  },
  sessionData: {
    persist: true,
    anonymous: false,
  },
};

// Messenger Actions
type CreateActionsObj<Controller extends keyof AuthenticationController> = {
  [K in Controller]: {
    type: `${typeof controllerName}:${K}`;
    handler: AuthenticationController[K];
  };
};
type ActionsObj = CreateActionsObj<
  | 'performSignIn'
  | 'performSignOut'
  | 'getBearerToken'
  | 'getSessionProfile'
  | 'isSignedIn'
>;
export type Actions =
  | ActionsObj[keyof ActionsObj]
  | AuthenticationControllerGetStateAction;
export type AuthenticationControllerGetStateAction = ControllerGetStateAction<
  typeof controllerName,
  AuthenticationControllerState
>;
export type AuthenticationControllerPerformSignIn = ActionsObj['performSignIn'];
export type AuthenticationControllerPerformSignOut =
  ActionsObj['performSignOut'];
export type AuthenticationControllerGetBearerToken =
  ActionsObj['getBearerToken'];
export type AuthenticationControllerGetSessionProfile =
  ActionsObj['getSessionProfile'];
export type AuthenticationControllerIsSignedIn = ActionsObj['isSignedIn'];

export type AuthenticationControllerStateChangeEvent =
  ControllerStateChangeEvent<
    typeof controllerName,
    AuthenticationControllerState
  >;

export type Events = AuthenticationControllerStateChangeEvent;

// Allowed Actions
export type AllowedActions =
  | HandleSnapRequest
  | KeyringControllerGetStateAction;

export type AllowedEvents =
  | KeyringControllerLockEvent
  | KeyringControllerUnlockEvent;

// Messenger
export type AuthenticationControllerMessenger = RestrictedControllerMessenger<
  typeof controllerName,
  Actions | AllowedActions,
  Events | AllowedEvents,
  AllowedActions['type'],
  AllowedEvents['type']
>;

/**
 * Controller that enables authentication for restricted endpoints.
 * Used for Global Profile Syncing and Notifications
 */
export default class AuthenticationController extends BaseController<
  typeof controllerName,
  AuthenticationControllerState,
  AuthenticationControllerMessenger
> {
  #metametrics: MetaMetricsAuth;

  #isUnlocked = false;

  #keyringController = {
    setupLockedStateSubscriptions: () => {
      const { isUnlocked } = this.messagingSystem.call(
        'KeyringController:getState',
      );
      this.#isUnlocked = isUnlocked;

      this.messagingSystem.subscribe('KeyringController:unlock', () => {
        this.#isUnlocked = true;
      });

      this.messagingSystem.subscribe('KeyringController:lock', () => {
        this.#isUnlocked = false;
      });
    },
  };

  constructor({
    messenger,
    state,
    metametrics,
  }: {
    messenger: AuthenticationControllerMessenger;
    state?: AuthenticationControllerState;
    /**
     * Not using the Messaging System as we
     * do not want to tie this strictly to extension
     */
    metametrics: MetaMetricsAuth;
  }) {
    super({
      messenger,
      metadata,
      name: controllerName,
      state: { ...defaultState, ...state },
    });

    if (!metametrics) {
      throw new Error('`metametrics` field is required');
    }

    this.#metametrics = metametrics;

    this.#keyringController.setupLockedStateSubscriptions();
    this.#registerMessageHandlers();
  }

  /**
   * Constructor helper for registering this controller's messaging system
   * actions.
   */
  #registerMessageHandlers(): void {
    this.messagingSystem.registerActionHandler(
      'AuthenticationController:getBearerToken',
      this.getBearerToken.bind(this),
    );

    this.messagingSystem.registerActionHandler(
      'AuthenticationController:getSessionProfile',
      this.getSessionProfile.bind(this),
    );

    this.messagingSystem.registerActionHandler(
      'AuthenticationController:isSignedIn',
      this.isSignedIn.bind(this),
    );

    this.messagingSystem.registerActionHandler(
      'AuthenticationController:performSignIn',
      this.performSignIn.bind(this),
    );

    this.messagingSystem.registerActionHandler(
      'AuthenticationController:performSignOut',
      this.performSignOut.bind(this),
    );
  }

  public async performSignIn(): Promise<string> {
    const { accessToken } = await this.#performAuthenticationFlow();
    return accessToken;
  }

  public performSignOut(): void {
    this.update((state) => {
      state.isSignedIn = false;
      state.sessionData = undefined;
    });
  }

  public async getBearerToken(): Promise<string> {
    this.#assertLoggedIn();

    if (this.#hasValidSession(this.state.sessionData)) {
      return this.state.sessionData.accessToken;
    }

    const { accessToken } = await this.#performAuthenticationFlow();
    return accessToken;
  }

  /**
   * Will return a session profile.
   * Throws if a user is not logged in.
   *
   * @returns profile for the session.
   */
  public async getSessionProfile(): Promise<SessionProfile> {
    this.#assertLoggedIn();

    if (this.#hasValidSession(this.state.sessionData)) {
      return this.state.sessionData.profile;
    }

    const { profile } = await this.#performAuthenticationFlow();
    return profile;
  }

  public isSignedIn(): boolean {
    return this.state.isSignedIn;
  }

  #assertLoggedIn(): void {
    if (!this.state.isSignedIn) {
      throw new Error(
        `${controllerName}: Unable to call method, user is not authenticated`,
      );
    }
  }

  async #performAuthenticationFlow(): Promise<{
    profile: SessionProfile;
    accessToken: string;
  }> {
    try {
      // 1. Nonce
      const publicKey = await this.#snapGetPublicKey();
      const nonce = await getNonce(publicKey);
      if (!nonce) {
        throw new Error(`Unable to get nonce`);
      }

      // 2. Login
      const rawMessage = createLoginRawMessage(nonce, publicKey);
      const signature = await this.#snapSignMessage(rawMessage);
      const loginResponse = await login(rawMessage, signature, {
        metametricsId: await this.#metametrics.getMetaMetricsId(),
        agent: this.#metametrics.agent,
      });
      if (!loginResponse?.token) {
        throw new Error(`Unable to login`);
      }

      const profile: SessionProfile = {
        identifierId: loginResponse.profile.identifier_id,
        profileId: loginResponse.profile.profile_id,
      };

      // 3. Trade for Access Token
      const accessToken = await getAccessToken(
        loginResponse.token,
        this.#metametrics.agent,
      );
      if (!accessToken) {
        throw new Error(`Unable to get Access Token`);
      }

      // Update Internal State
      this.update((state) => {
        state.isSignedIn = true;
        const expiresIn = new Date();
        expiresIn.setTime(expiresIn.getTime() + THIRTY_MIN_MS);
        state.sessionData = {
          profile,
          accessToken,
          expiresIn: expiresIn.toString(),
        };
      });

      return {
        profile,
        accessToken,
      };
    } catch (e) {
      console.error('Failed to authenticate', e);
      const errorMessage =
        e instanceof Error ? e.message : JSON.stringify(e ?? '');
      throw new Error(
        `${controllerName}: Failed to authenticate - ${errorMessage}`,
      );
    }
  }

  #hasValidSession(
    sessionData: SessionData | undefined,
  ): sessionData is SessionData {
    if (!sessionData) {
      return false;
    }

    const prevDate = Date.parse(sessionData.expiresIn);
    if (isNaN(prevDate)) {
      return false;
    }

    const currentDate = new Date();
    const diffMs = Math.abs(currentDate.getTime() - prevDate);

    return THIRTY_MIN_MS > diffMs;
  }

  #_snapPublicKeyCache: string | undefined;

  /**
   * Returns the auth snap public key.
   *
   * @returns The snap public key.
   */
  async #snapGetPublicKey(): Promise<string> {
    if (this.#_snapPublicKeyCache) {
      return this.#_snapPublicKeyCache;
    }

    if (!this.#isUnlocked) {
      throw new Error(
        '#snapGetPublicKey - unable to call snap, wallet is locked',
      );
    }

    const result = (await this.messagingSystem.call(
      'SnapController:handleRequest',
      createSnapPublicKeyRequest(),
    )) as string;

    this.#_snapPublicKeyCache = result;

    return result;
  }

  #_snapSignMessageCache: Record<`metamask:${string}`, string> = {};

  /**
   * Signs a specific message using an underlying auth snap.
   *
   * @param message - A specific tagged message to sign.
   * @returns A Signature created by the snap.
   */
  async #snapSignMessage(message: `metamask:${string}`): Promise<string> {
    if (this.#_snapSignMessageCache[message]) {
      return this.#_snapSignMessageCache[message];
    }

    if (!this.#isUnlocked) {
      throw new Error(
        '#snapSignMessage - unable to call snap, wallet is locked',
      );
    }

    const result = (await this.messagingSystem.call(
      'SnapController:handleRequest',
      createSnapSignMessageRequest(message),
    )) as string;

    this.#_snapSignMessageCache[message] = result;

    return result;
  }
}
