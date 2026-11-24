import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { AccountsResponse, User } from '@ghostfolio/common/interfaces';
import { AccountWithValue } from '@ghostfolio/common/types';
import { DataService } from '@ghostfolio/ui/services';

import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, RouterModule } from '@angular/router';
import { BehaviorSubject, of, Subject } from 'rxjs';

import { GfAccountsPageComponent } from './accounts-page.component';

jest.mock('@ghostfolio/client/services/user/user.service', () => ({
  UserService: class {}
}));

jest.mock('@ghostfolio/ui/accounts-table', () => ({
  GfAccountsTableComponent: class {}
}));

jest.mock('@ghostfolio/ui/fab', () => ({
  GfFabComponent: class {}
}));

describe('GfAccountsPageComponent', () => {
  let accountsResponse$: Subject<AccountsResponse>;
  let fixture: ComponentFixture<GfAccountsPageComponent>;

  const user = {
    accounts: [{ id: 'account-1' }],
    permissions: [],
    scopes: [],
    settings: { baseCurrency: 'USD', isRestrictedView: false, locale: 'en-US' }
  } as unknown as User;

  const createAccountsResponse = (count: number): AccountsResponse => {
    return {
      accounts: Array.from({ length: count }, (_, index) => {
        return { id: `account-${index}` } as AccountWithValue;
      }),
      activitiesCount: 0,
      totalBalanceInBaseCurrency: 0,
      totalValueInBaseCurrency: 0
    } as AccountsResponse;
  };

  const getHeadingText = () => {
    return (fixture.nativeElement as HTMLElement)
      .querySelector('h1')
      .textContent.replace(/\s+/g, ' ')
      .trim();
  };

  beforeEach(async () => {
    accountsResponse$ = new Subject<AccountsResponse>();

    await TestBed.configureTestingModule({
      imports: [GfAccountsPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: DataService,
          useValue: {
            fetchAccounts: () => accountsResponse$.asObservable()
          }
        },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        {
          provide: UserService,
          useValue: {
            getFilters: () => [],
            stateChanged: new BehaviorSubject({ user })
          }
        }
      ]
    })
      .overrideComponent(GfAccountsPageComponent, {
        set: { imports: [RouterModule], schemas: [NO_ERRORS_SCHEMA] }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfAccountsPageComponent);
    fixture.detectChanges();
  });

  it('should hide the count while the accounts are loading', () => {
    expect(getHeadingText()).toBe('Accounts');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.accounts-count')
    ).toBeNull();
  });

  it('should show the number of accounts in the heading', () => {
    accountsResponse$.next(createAccountsResponse(3));
    fixture.detectChanges();

    expect(getHeadingText()).toBe('Accounts (3)');
  });

  it('should show a count of zero when there are no accounts', () => {
    accountsResponse$.next(createAccountsResponse(0));
    fixture.detectChanges();

    expect(getHeadingText()).toBe('Accounts (0)');
  });
});
