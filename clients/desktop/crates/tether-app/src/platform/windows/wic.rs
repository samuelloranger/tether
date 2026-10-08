use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, IStream,
    STATFLAG_NONAME, STREAM_SEEK_SET,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::core::GUID;

use crate::terminal::files::ImageCodec;

pub struct WicCodec;

impl ImageCodec for WicCodec {
    fn to_jpeg(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let input = SHCreateMemStream(Some(bytes))?;
            let decoder = factory
                .CreateDecoderFromStream(&input, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
                .ok()?;
            let frame = decoder.GetFrame(0).ok()?;
            let bgr = WICConvertBitmapSource(&GUID_WICPixelFormat24bppBGR, &frame).ok()?;
            let (mut w, mut h) = (0, 0);
            bgr.GetSize(&mut w, &mut h).ok()?;

            let output: IStream = SHCreateMemStream(None)?;
            let encoder = factory
                .CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())
                .ok()?;
            encoder.Initialize(&output, WICBitmapEncoderNoCache).ok()?;
            let mut out_frame = None;
            let mut props: Option<IPropertyBag2> = None;
            encoder.CreateNewFrame(&mut out_frame, &mut props).ok()?;
            let out_frame = out_frame?;
            if let Some(props) = props.as_ref() {
                let mut name: Vec<u16> = "ImageQuality".encode_utf16().chain([0]).collect();
                let bag = PROPBAG2 {
                    pstrName: windows::core::PWSTR(name.as_mut_ptr()),
                    ..Default::default()
                };
                let quality = VARIANT::from(0.9f32);
                let _ = props.Write(1, &bag, &quality);
            }
            out_frame.Initialize(props.as_ref()).ok()?;
            out_frame.SetSize(w, h).ok()?;
            let mut format: GUID = GUID_WICPixelFormat24bppBGR;
            out_frame.SetPixelFormat(&mut format).ok()?;
            out_frame.WriteSource(&bgr, std::ptr::null()).ok()?;
            out_frame.Commit().ok()?;
            encoder.Commit().ok()?;

            let mut stat = Default::default();
            output.Stat(&mut stat, STATFLAG_NONAME).ok()?;
            output.Seek(0, STREAM_SEEK_SET, None).ok()?;
            let mut jpeg = vec![0u8; stat.cbSize as usize];
            let mut read = 0u32;
            output
                .Read(jpeg.as_mut_ptr().cast(), jpeg.len() as u32, Some(&mut read))
                .ok()
                .ok()?;
            jpeg.truncate(read as usize);
            Some(jpeg)
        }
    }
}
