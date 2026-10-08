/// One frame in flight at a time. Output that lands while a frame is on its way only
/// marks the next one dirty, and the next frame starts when the window reports the last
/// one presented. The grid therefore repaints at most once per display refresh.
#[derive(Debug, Default)]
pub struct FramePacer {
    dirty: bool,
    in_flight: bool,
}

impl FramePacer {
    pub fn mark_dirty(&mut self) -> bool {
        if self.in_flight {
            self.dirty = true;
            return false;
        }
        self.in_flight = true;
        true
    }

    pub fn presented(&mut self) -> bool {
        self.in_flight = false;
        if !self.dirty {
            return false;
        }
        self.dirty = false;
        self.in_flight = true;
        true
    }

    /// Nothing to draw after all (no active tab): free the slot.
    pub fn cancel(&mut self) {
        self.in_flight = false;
        self.dirty = false;
    }
}

use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::Duration;

use slint::{ComponentHandle, Image, Rgba8Pixel, SharedPixelBuffer};
use tether_term::{Rasterizer, RenderStyle, RgbaImage, Snapshot};

use crate::{AppWindow, TerminalVm};

pub const BLINK: Duration = Duration::from_millis(530);

#[allow(clippy::large_enum_variant)]
pub enum FrameJob {
    Grid {
        snapshot: Snapshot,
        style: RenderStyle<'static>,
        width: u32,
        height: u32,
    },
    Clear {
        width: u32,
        height: u32,
        background: u32,
    },
}

pub fn render_job(r: &mut Rasterizer, job: &FrameJob) -> RgbaImage {
    match job {
        FrameJob::Grid {
            snapshot,
            style,
            width,
            height,
        } => r.render(snapshot, style, *width, *height),
        FrameJob::Clear {
            width,
            height,
            background,
        } => {
            let [_, red, green, blue] = background.to_be_bytes();
            let pixels = [red, green, blue, 0xFF].repeat((*width * *height) as usize);
            RgbaImage {
                width: *width,
                height: *height,
                pixels,
            }
        }
    }
}

static RENDER_TX: OnceLock<mpsc::Sender<FrameJob>> = OnceLock::new();
static PRESENTED: Mutex<Option<Arc<dyn Fn() + Send + Sync>>> = Mutex::new(None);

fn presented() {
    if let Some(p) = PRESENTED.lock().unwrap().clone() {
        p();
    }
}

/// Starts the render thread once per window, and points the "frame shown" signal at
/// the terminal that is open now.
pub fn attach_window(app: &AppWindow, on_presented: Arc<dyn Fn() + Send + Sync>) {
    *PRESENTED.lock().unwrap() = Some(on_presented);
    if RENDER_TX.get().is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<FrameJob>();
    let _ = RENDER_TX.set(tx);
    let weak = app.as_weak();
    // The renderer's AfterRendering is the display-refresh signal. On a backend without
    // rendering notifiers, fall back to "the UI thread took the frame".
    let notifier = app.window().set_rendering_notifier(|state, _| {
        if matches!(state, slint::RenderingState::AfterRendering) {
            presented();
        }
    });
    let notify_on_set = notifier.is_err();
    std::thread::Builder::new()
        .name("tether-render".into())
        .spawn(move || {
            let mut rasterizer = Rasterizer::new();
            while let Ok(mut job) = rx.recv() {
                while let Ok(newer) = rx.try_recv() {
                    job = newer;
                }
                let img = render_job(&mut rasterizer, &job);
                let mut buf = SharedPixelBuffer::<Rgba8Pixel>::new(img.width, img.height);
                buf.make_mut_bytes().copy_from_slice(&img.pixels);
                let (w, h) = (img.width as i32, img.height as i32);
                let _ = weak.upgrade_in_event_loop(move |app| {
                    let vm = app.global::<TerminalVm>();
                    vm.set_frame(Image::from_rgba8(buf));
                    vm.set_frame_width(w);
                    vm.set_frame_height(h);
                    if notify_on_set {
                        presented();
                    }
                });
            }
        })
        .expect("render thread");
}

pub fn submit(job: FrameJob) {
    if let Some(tx) = RENDER_TX.get() {
        let _ = tx.send(job);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_coalesce_while_in_flight() {
        let mut p = FramePacer::default();
        assert!(p.mark_dirty());
        for _ in 0..1000 {
            assert!(!p.mark_dirty());
        }
        assert!(p.presented());
        assert!(!p.presented());
        assert!(p.mark_dirty());
    }

    #[test]
    fn cancel_frees_the_slot() {
        let mut p = FramePacer::default();
        assert!(p.mark_dirty());
        p.cancel();
        assert!(p.mark_dirty());
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;
    use crate::terminal::model::tests::{live, t};
    use crate::terminal::model::{Effect, Msg};
    use crate::terminal::testkit::session;

    fn redraws(fx: &[Effect]) -> usize {
        fx.iter().filter(|e| **e == Effect::Redraw).count()
    }

    #[test]
    fn background_output_does_not_render() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(1));
        m.handle(Msg::Attached { name: "a".into() }, t(1));
        assert_eq!(
            redraws(&m.handle(
                Msg::PtyData {
                    name: "b".into(),
                    bytes: b"y\r\n".repeat(500),
                },
                t(2)
            )),
            0
        );
        assert_eq!(
            redraws(&m.handle(
                Msg::PtyData {
                    name: "a".into(),
                    bytes: b"x".to_vec(),
                },
                t(3)
            )),
            1
        );
    }

    #[test]
    fn no_frame_before_the_well_has_a_size() {
        assert!(live(vec![session("a", 1)]).frame_job().is_none());
    }

    #[test]
    fn the_frame_is_the_well_in_physical_pixels() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::WellResized {
                width_px: 1280,
                height_px: 800,
                scale: 2.0,
            },
            t(1),
        );
        let Some(FrameJob::Grid {
            width,
            height,
            style,
            ..
        }) = m.frame_job()
        else {
            panic!("expected a grid frame")
        };
        assert_eq!((width, height), (1280, 800));
        assert!((style.size_px - tether_term::pt_to_px(14.0, 2.0)).abs() < 0.01);
        assert_eq!(
            style.padding_px,
            tether_term::pt_to_px(8.0, 2.0).round() as u32
        );
    }

    #[test]
    fn an_empty_host_clears_the_well() {
        let mut m = live(vec![]);
        m.handle(
            Msg::WellResized {
                width_px: 640,
                height_px: 400,
                scale: 1.0,
            },
            t(1),
        );
        assert!(matches!(
            m.frame_job(),
            Some(FrameJob::Clear {
                width: 640,
                height: 400,
                background: 0x1E1E2E
            })
        ));
    }

    #[test]
    fn the_grid_is_bottom_anchored_on_the_theme_background() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(
            Msg::WellResized {
                width_px: 800,
                height_px: 600,
                scale: 1.0,
            },
            t(1),
        );
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: b"hello".to_vec(),
            },
            t(2),
        );
        let job = m.frame_job().unwrap();
        let img = render_job(&mut tether_term::Rasterizer::new(), &job);
        assert_eq!((img.width, img.height), (800, 600));
        assert_eq!(img.pixel(0, 0), [0x1E, 0x1E, 0x2E, 0xFF]);
        assert_eq!(img.pixel(799, 599), [0x1E, 0x1E, 0x2E, 0xFF]);
    }

    #[test]
    fn synchronized_output_is_flushed_by_the_tick() {
        let mut m = live(vec![session("a", 1)]);
        // A query inside a synchronized update is answered when the update ends or times out.
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: b"\x1b[?2026h\x1b]11;?\x07".to_vec(),
            },
            t(1),
        );
        std::thread::sleep(std::time::Duration::from_millis(400));
        let fx = m.handle(Msg::Tick, t(450));
        assert!(fx.iter().any(|e| matches!(
            e,
            Effect::Write { name, bytes }
                if name == "a" && bytes.starts_with(b"\x1b]11;rgb:")
        )));
    }

    #[test]
    fn blink_toggles_the_cursor_only_when_enabled() {
        let mut m = live(vec![session("a", 1)]);
        assert_eq!(redraws(&m.handle(Msg::Tick, t(600))), 0);
        m.handle(
            Msg::StyleChanged(crate::terminal::geometry::TermStyle {
                blink: true,
                ..Default::default()
            }),
            t(700),
        );
        assert_eq!(redraws(&m.handle(Msg::Tick, t(1_300))), 1);
    }
}
