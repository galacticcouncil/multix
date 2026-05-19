import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { MultisigsAndPureByAccountQuery, ProxyType } from '../../types-and-hooks';
import { AccountBaseInfo } from '../components/select/GenericAccountSelection';
import { useQueryMultisigsAndPureByAccounts } from '../hooks/useQueryMultisigsAndPureByAccounts';
import { useAccounts } from './AccountsContext';
import { useWatchedAccounts } from './WatchedAccountsContext';
import { useAccountId } from '../hooks/useAccountId';
import { getMultiProxyAddress } from '../utils/getMultiProxyAddress';
import { useSearchParams } from 'react-router';
import { useNetwork } from './NetworkContext';
import { useHiddenAccounts } from './HiddenAccountsContext';
import { useGetEncodedAddress } from '../hooks/useGetEncodedAddress';
import { getPubKeyFromAddress } from '../utils/getPubKeyFromAddress';
import { encodesubstrateAddress } from '../utils/encodeSubstrateAddress';
import { useApi } from './ApiContext';

interface MultisigContextProps {
    children: React.ReactNode | React.ReactNode[];
}

export interface MultisigAggregated {
    address: string;
    signatories?: string[];
    threshold?: number | null;
    type: ProxyType;
}

export interface MultiProxy {
    /** The leaf proxy address — i.e. the account the user identifies as when this entry is selected. */
    proxy?: string;
    /**
     * Full chain of pure-proxy addresses ordered from **outermost wrap** (closest
     * to the multisig) to **innermost / leaf**. For a flat M→PA setup this is just
     * `[PA]`; for nested M→PA→PB it is `[PA, PB]`. Always ends with `proxy` when
     * `proxy` is set. Useful for stripping all implicit `proxy.proxy` wraps when
     * displaying calls.
     */
    proxyChain?: string[];
    multisigs: MultisigAggregated[];
}

export const isMultiProxy = (value: any): value is MultiProxy =>
    value && value.multisigs && value.multisigs.length > 0;

export interface IMultisigContext {
    selectedMultiProxy?: MultiProxy;
    multiProxyList: MultiProxy[];
    isLoading: boolean;
    selectMultiProxy: (multi: MultiProxy | string) => boolean;
    selectedHasProxy: boolean;
    error: unknown | Error | null;
    getMultisigByAddress: (address: string) => MultisigAggregated | undefined;
    getMultisigAsAccountBaseInfo: () => AccountBaseInfo[];
    selectedIsWatched: boolean;
    isWatchedAccount: (who: string | MultiProxy | undefined) => boolean;
    refetch: () => void;
    defaultAddress?: string;
    selectedMultiProxyAddress?: string;
    setCanFindMultiProxyFromUrl: React.Dispatch<React.SetStateAction<boolean>>;
    canFindMultiProxyFromUrl: boolean;
    setRefetchMultisigTimeoutMinutes: React.Dispatch<React.SetStateAction<number>>;
}

const MultisigContext = createContext<IMultisigContext | undefined>(undefined);

const MultiProxyContextProvider = ({ children }: MultisigContextProps) => {
    const { chainInfo } = useApi();
    const { selectedNetwork } = useNetwork();
    const getEncodedAddress = useGetEncodedAddress();
    const { networkHiddenAccounts } = useHiddenAccounts();
    const [refetchMultisigTimeoutMinutes, setRefetchMultisigTimeoutMinutes] = useState(0);
    const [canFindMultiProxyFromUrl, setCanFindMultiProxyFromUrl] = useState(false);
    const [selectedMultiProxyAddress, setSelectedMultiProxyAddress] = useState('');
    const { ownAddressList } = useAccounts();
    const ownPubKeys = useMemo(() => getPubKeyFromAddress(ownAddressList), [ownAddressList]);
    const ownAccountIds = useAccountId(ownPubKeys);
    const { watchedPubKeys } = useWatchedAccounts();
    const watchedAccountIds = useAccountId(watchedPubKeys);

    const LOCALSTORAGE_LAST_MULTIPROXY_KEY_NETWORK = useMemo(
        () => `multix.lastUsedMultiProxy.v2.${selectedNetwork}`,
        [selectedNetwork],
    );

    const getSignatoriesAddressesFromAccount = useCallback(
        (signatories: MultisigsAndPureByAccountQuery['accounts'][0]['signatories']) => {
            return signatories
                .map(({ signatory }) => getEncodedAddress(signatory.pubKey))
                .filter(Boolean) as string[];
        },
        [getEncodedAddress],
    );

    const {
        data,
        isLoading,
        error: multisigQueryError,
        refetch,
    } = useQueryMultisigsAndPureByAccounts({
        accountIds: ownAccountIds,
        watchedAccountIds: watchedAccountIds,
        shouldRefetch: refetchMultisigTimeoutMinutes > 0,
    });

    const multisigList = useMemo(() => {
        if (!data || data.accounts.length === 0) return [];

        // Lookup any account record by its pubKey so we can walk pure-to-pure
        // delegation links (PA→PB) past the immediate edge available on
        // `delegateeFor.delegator` (which only carries pubKey/isPureProxy).
        // Pure proxies further up the chain need to be in the GraphQL response
        // — which today means the user has watched them — otherwise we can't
        // see beyond what each account's edges advertise about itself.
        const accountByPubKey = new Map<string, (typeof data.accounts)[number]>();
        data.accounts.forEach((account) => accountByPubKey.set(account.pubKey, account));

        // Walk "this-account can-act-for" links upward through pure proxies and
        // return every chain reachable from `fromPubKey`. Each chain is ordered
        // outermost-wrap → leaf (i.e. closest-to-multisig first). The proxy
        // type used for the **first hop** is returned alongside each chain so
        // we can label the multisig→leaf relationship correctly.
        const buildChainsFrom = (
            fromPubKey: string,
            visited: Set<string>,
        ): Array<{ chain: string[]; firstHopType: ProxyType }> => {
            if (visited.has(fromPubKey)) return [];
            const account = accountByPubKey.get(fromPubKey);
            if (!account) return [];
            const nextVisited = new Set(visited);
            nextVisited.add(fromPubKey);

            const chains: Array<{ chain: string[]; firstHopType: ProxyType }> = [];
            account.delegateeFor.forEach(({ delegator, type }) => {
                if (!delegator?.isPureProxy) return;
                const delegatorAddress = getEncodedAddress(delegator.pubKey) || '';
                if (!delegatorAddress) return;

                // direct hop: this account can act as `delegator`
                chains.push({ chain: [delegatorAddress], firstHopType: type });

                // recurse: if we have the delegator's full record, extend further
                const subChains = buildChainsFrom(delegator.pubKey, nextVisited);
                for (const sub of subChains) {
                    chains.push({
                        chain: [delegatorAddress, ...sub.chain],
                        // the first hop from THIS account is still `type`,
                        // regardless of how the chain continues from delegator
                        firstHopType: type,
                    });
                }
            });
            return chains;
        };

        // Keyed by chain.join('/') so two different chains landing on the same
        // leaf (rare but possible) get distinct entries.
        const chainMap = new Map<
            string,
            { proxyChain: string[]; multisigs: MultisigAggregated[] }
        >();
        const standaloneMultisigs: MultiProxy[] = [];

        data.accounts.forEach((account) => {
            if (!account.isMultisig) return; // pure proxies are visited transitively

            const multisigAddress = getEncodedAddress(account.pubKey) || '';
            const multisigSignatories = getSignatoriesAddressesFromAccount(account.signatories);

            const chains = buildChainsFrom(account.pubKey, new Set());

            if (chains.length === 0) {
                standaloneMultisigs.push({
                    proxy: undefined,
                    multisigs: [
                        {
                            address: multisigAddress,
                            signatories: multisigSignatories,
                            threshold: account.threshold,
                        },
                    ],
                } as MultiProxy);
                return;
            }

            chains.forEach(({ chain, firstHopType }) => {
                const key = chain.join('/');
                const existing = chainMap.get(key);
                const multisigEntry: MultisigAggregated = {
                    address: multisigAddress,
                    signatories: multisigSignatories,
                    threshold: account.threshold ?? undefined,
                    type: firstHopType,
                };
                if (existing) {
                    if (existing.multisigs.some((m) => m.address === multisigAddress)) return;
                    existing.multisigs.push(multisigEntry);
                } else {
                    chainMap.set(key, {
                        proxyChain: chain,
                        multisigs: [multisigEntry],
                    });
                }
            });
        });

        const proxiedEntries: MultiProxy[] = Array.from(chainMap.values()).map(
            ({ proxyChain, multisigs }) => ({
                proxy: proxyChain[proxyChain.length - 1],
                proxyChain,
                multisigs,
            }),
        );

        return [...standaloneMultisigs, ...proxiedEntries];
    }, [getEncodedAddress, getSignatoriesAddressesFromAccount, data]);

    const multiProxyList = useMemo(() => {
        const filteredMulti = multisigList.filter(({ proxy, multisigs }) => {
            if (proxy) return !networkHiddenAccounts.includes(proxy);

            const firstMultisig = multisigs[0].address;
            return !!firstMultisig && !networkHiddenAccounts.includes(firstMultisig);
        });
        return filteredMulti;
    }, [multisigList, networkHiddenAccounts]);

    const getMultiProxyByAddress = useCallback(
        (address?: string) => {
            if (!address) return undefined;

            return multiProxyList.find(
                (multiProxy) =>
                    // either by proxy address
                    multiProxy.proxy === address ||
                    // or by multisig address
                    multiProxy.multisigs.some((multisig) => multisig.address === address),
            );
        },
        [multiProxyList],
    );

    const selectedMultiProxy = useMemo(() => {
        if (!selectedMultiProxyAddress) return;

        return getMultiProxyByAddress(selectedMultiProxyAddress);
    }, [getMultiProxyByAddress, selectedMultiProxyAddress]);

    const selectedHasProxy = useMemo(() => !!selectedMultiProxy?.proxy, [selectedMultiProxy]);

    // This is true if the currently Multiproxy passed as param contains no signatory
    // owned by the user this happens with a watched account
    const isWatchedAccount = useCallback(
        (who: string | MultiProxy | undefined) => {
            if (!who) return false;

            const account = typeof who === 'string' ? getMultiProxyByAddress(who) : who;
            return !account?.multisigs.some((multisig) =>
                multisig.signatories?.some((signatory) => ownAddressList.includes(signatory)),
            );
        },
        [getMultiProxyByAddress, ownAddressList],
    );

    const selectedIsWatched = useMemo(
        () => isWatchedAccount(selectedMultiProxy),
        [isWatchedAccount, selectedMultiProxy],
    );

    const [, setSearchParams] = useSearchParams({
        address: '',
    });

    const setAddressInUrl = useCallback(
        (address: string) => {
            setSearchParams((prev) => {
                prev.set('address', address);
                return prev;
            });
        },
        [setSearchParams],
    );

    useEffect(() => {
        if (refetchMultisigTimeoutMinutes <= 0) return;
        const timeoutInMs = refetchMultisigTimeoutMinutes * 60 * 1000;
        const timeout = setTimeout(() => {
            setRefetchMultisigTimeoutMinutes(0);
        }, timeoutInMs);
        return () => clearTimeout(timeout);
    }, [refetchMultisigTimeoutMinutes]);

    const getMultisigByAddress = useCallback(
        (address: string) => {
            return selectedMultiProxy?.multisigs.find((multisig) => multisig.address === address);
        },
        [selectedMultiProxy],
    );

    const getMultisigAsAccountBaseInfo = () =>
        selectedMultiProxy?.multisigs.map(
            ({ address }) =>
                ({
                    address,
                    meta: {
                        isMulti: true,
                    },
                }) as AccountBaseInfo,
        ) || [];

    const selectMultiProxy = useCallback(
        (newMulti: typeof selectedMultiProxy | string) => {
            let multi: string | undefined;

            if (typeof newMulti === 'string') {
                multi = newMulti;
            } else {
                multi = getMultiProxyAddress(newMulti);
            }

            const multiProxyFound = getMultiProxyByAddress(multi);

            if (!multi || !multiProxyFound) {
                return false;
            }

            if (multiProxyFound && LOCALSTORAGE_LAST_MULTIPROXY_KEY_NETWORK) {
                const pubKey = getPubKeyFromAddress(multi);
                pubKey && localStorage.setItem(LOCALSTORAGE_LAST_MULTIPROXY_KEY_NETWORK, pubKey);
            }

            setAddressInUrl(multi);
            setSelectedMultiProxyAddress(multi);
            return true;
        },
        [LOCALSTORAGE_LAST_MULTIPROXY_KEY_NETWORK, getMultiProxyByAddress, setAddressInUrl],
    );

    const defaultAddress = useMemo(() => {
        if (multiProxyList.length === 0 || isLoading) {
            return undefined;
        }

        const lastUsedMultiProxyPubKey =
            LOCALSTORAGE_LAST_MULTIPROXY_KEY_NETWORK &&
            localStorage.getItem(LOCALSTORAGE_LAST_MULTIPROXY_KEY_NETWORK);

        if (lastUsedMultiProxyPubKey && chainInfo) {
            const lastUsedAddress = encodesubstrateAddress(
                lastUsedMultiProxyPubKey,
                chainInfo.ss58Format,
            );
            const lastUsedMultiProxy = getMultiProxyByAddress(lastUsedAddress);

            if (lastUsedMultiProxy) {
                return lastUsedAddress;
            }
        }

        return multiProxyList[0].proxy || multiProxyList[0].multisigs[0].address;
    }, [
        LOCALSTORAGE_LAST_MULTIPROXY_KEY_NETWORK,
        chainInfo,
        getMultiProxyByAddress,
        isLoading,
        multiProxyList,
    ]);

    return (
        <MultisigContext.Provider
            value={{
                defaultAddress,
                selectedMultiProxyAddress,
                selectedMultiProxy,
                multiProxyList,
                selectMultiProxy,
                isLoading,
                selectedHasProxy,
                error: multisigQueryError,
                getMultisigByAddress,
                getMultisigAsAccountBaseInfo,
                selectedIsWatched,
                refetch,
                canFindMultiProxyFromUrl,
                setCanFindMultiProxyFromUrl,
                isWatchedAccount,
                setRefetchMultisigTimeoutMinutes,
            }}
        >
            {children}
        </MultisigContext.Provider>
    );
};

const useMultiProxy = () => {
    const context = useContext(MultisigContext);
    if (context === undefined) {
        throw new Error('useMultiProxy must be used within a MultiProxyContextProvider');
    }
    return context;
};

export { MultiProxyContextProvider, useMultiProxy };
