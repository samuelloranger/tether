import { act, render } from '@testing-library/react-native';
import * as SplashScreen from 'expo-splash-screen';
import { LaunchOverlay } from '../src/LaunchOverlay';

// The whole point of the overlay is the handoff: the native splash must stay up
// until this thing has painted, and it must get out of the way afterwards. Both
// failure modes (a blank frame at launch, an overlay that never leaves) are
// invisible in a unit test of the animation alone.
jest.mock('expo-splash-screen', () => ({ hideAsync: jest.fn(() => Promise.resolve()) }));

const hideAsync = SplashScreen.hideAsync as jest.Mock;

beforeEach(() => {
  hideAsync.mockClear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function layout(view: ReturnType<typeof render>) {
  act(() => {
    view.getByTestId('launch-overlay').props.onLayout?.({
      nativeEvent: { layout: { width: 400, height: 800, x: 0, y: 0 } },
    });
  });
}

test('the native splash is held until the overlay has laid out', () => {
  const view = render(<LaunchOverlay ready={false} />);
  expect(hideAsync).not.toHaveBeenCalled();
  layout(view);
  expect(hideAsync).toHaveBeenCalledTimes(1);
});

test('the native splash is hidden only once across re-layouts', () => {
  const view = render(<LaunchOverlay ready={false} />);
  layout(view);
  layout(view);
  expect(hideAsync).toHaveBeenCalledTimes(1);
});

test('the overlay stays mounted while the app is not ready', () => {
  const view = render(<LaunchOverlay ready={false} />);
  layout(view);
  act(() => {
    jest.advanceTimersByTime(2000);
  });
  expect(view.queryByTestId('launch-overlay')).not.toBeNull();
});

test('the overlay unmounts after animating out once ready', () => {
  const view = render(<LaunchOverlay ready={false} />);
  layout(view);
  view.rerender(<LaunchOverlay ready={true} />);
  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(view.queryByTestId('launch-overlay')).toBeNull();
});
