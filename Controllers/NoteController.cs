using ELAuth.Helper;
using HtmlAgilityPack;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.StaticFiles;
using NoteApp.Models;
using NoteApp.Services;
using NoteAppPWA.Controllers;
using NoteAppPWA.Helper;
using NoteAppPWA.Models;
using System.Drawing;
using System.Web;
using static System.Net.Mime.MediaTypeNames;
using static System.Runtime.InteropServices.JavaScript.JSType;

namespace NoteApp.Controllers
{
    public class NoteController : BaseController
    {
        private readonly INoteService _noteService;
        private readonly IDailyEntryService _entryService;
        private readonly IEmailHelper _emailHelper;
        private readonly IFileHelper _fileHelper;
        private readonly IConfiguration _configuration;
        private readonly IWebHostEnvironment _env;

        public NoteController(INoteService noteService, IDailyEntryService entryService, IConfiguration configuration, IWebHostEnvironment env)
        {
            _configuration = configuration;
            _env = env;
            _noteService = noteService;
            _entryService = entryService;
            _emailHelper = new EmailHelper(_configuration);
            _fileHelper = new FileHelper(_configuration, _env);
        }
        public IActionResult Detail(int id, string? date)
        {
            var note = _noteService.GetNoteById(id);
            if (note == null) return NotFound();

            var entries = _entryService.GetEntriesByNoteId(id);
            entries = entries.OrderByDescending(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).ToList();
            DateTime latest = entries.OrderByDescending(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).Select(e => !string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now).FirstOrDefault();
            var selectedDate = string.IsNullOrEmpty(date) || date != "null" ? latest : DateTime.Parse(date);
            //var selectedEntry = entries.FirstOrDefault(e => (!string.IsNullOrEmpty(e.Date) ? Convert.ToDateTime(e.Date) : DateTime.Now) == selectedDate.Date);


            ViewBag.SelectedDate = selectedDate;
            ViewBag.Entries = _entryService.GetEntryListDateByNoteId(id);
            //ViewBag.Entry = selectedEntry;
            ViewBag.NoteTitle = note.Title;

            return View(note);
        }


        [HttpGet]
        public async Task<IActionResult> GetDetailNote(string? id, string? date, string? noteId)
        {
            try
            {
                DailyEntry entry = new();
                if (!string.IsNullOrEmpty(id))
                {
                    entry = _entryService.GetEntryById(int.Parse(id));
                }
                else
                {
                    if (!string.IsNullOrEmpty(noteId))
                    {

                        entry = _entryService.GetEntriesByNoteId(int.Parse(noteId)).FirstOrDefault();

                    }
                }
                entry.Content = await ProcessHtmlImagesWithAzure(entry.Content, embedBase64InsteadOfUrl: false);
                return Json(new { success = true, message = "success get detail", data = entry });
            }
            catch (Exception e)
            {
                return Json(new { success = false, message = "failed get detail" });
            }
        }

        private async Task<string> ProcessHtmlImagesWithAzure(string htmlContent, bool checkExisting = false, bool embedBase64InsteadOfUrl = false, bool isHeader = false)
        {
            if (string.IsNullOrEmpty(htmlContent))
                return htmlContent;

            var doc = new HtmlDocument();
            doc.LoadHtml(htmlContent);
            var imgNodes = doc.DocumentNode.SelectNodes("//img");

            if (imgNodes == null)
                return htmlContent;

            foreach (var imgNode in imgNodes)
            {
                var src = imgNode.GetAttributeValue("src", "");

                // Skip if it's not a base64 image
                if (!src.StartsWith("data:image"))
                    continue;

                try
                {
                    // ✅ Ambil atribut height & width (kalau ada)
                    var originalWidth = imgNode.GetAttributeValue("width", "");
                    var originalHeight = imgNode.GetAttributeValue("height", "");

                    var base64Data = src.Split(',')[1];
                    var imageBytes = Convert.FromBase64String(base64Data);

                    using (var ms = new MemoryStream(imageBytes))
                    using (var compressedStream = FileHelper.SaveCompressedImageToStream(ms, 75))
                    {
                        var fileName = $"img_{Guid.NewGuid()}.jpg";
                        var yearMonth = $"Uploads/{DateTime.Now.Year}/{DateTime.Now.Month:D2}";
                        var filePath = Path.Combine(yearMonth, fileName);

                        try
                        {
                            await _fileHelper.UploadFileAsync(filePath, compressedStream);
                        }
                        catch (Exception azureEx)
                        {
                            System.Diagnostics.Debug.WriteLine($"Azure upload failed: {azureEx.Message}");
                        }

                        // Reset stream position for base64 encoding
                        compressedStream.Seek(0, SeekOrigin.Begin);
                        var finalBytes = compressedStream.ToArray();
                        var base64Final = Convert.ToBase64String(finalBytes);
                        var mimeType = "image/jpeg"; // because we saved as jpg
                        var base64Src = $"data:{mimeType};base64,{base64Final}";

                        if (embedBase64InsteadOfUrl)
                        {
                            imgNode.SetAttributeValue("src", base64Src);
                        }
                        else
                        {
                            var baseUrl = $"{Request.Scheme}://{Request.Host}{Request.PathBase}";
                            var webPath = $"{baseUrl}/Note/ReadFileImageForTiny?filename={HttpUtility.UrlEncode(fileName)}&filePath={HttpUtility.UrlEncode(filePath)}";

                            imgNode.SetAttributeValue("src", webPath);
                        }

                        // ✅ Pasang kembali width & height kalau ada
                        if (!string.IsNullOrEmpty(originalWidth))
                            imgNode.SetAttributeValue("width", originalWidth);

                        if (!string.IsNullOrEmpty(originalHeight))
                            imgNode.SetAttributeValue("height", originalHeight);
                    }
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"Error processing image: {ex.Message}");
                    continue;
                }
            }

            return doc.DocumentNode.OuterHtml;
        }

        public static async Task<bool> IsImageUrlValidAsync(string imageUrl)
        {
            try
            {
                using (var httpClient = new HttpClient())
                {
                    var request = new HttpRequestMessage(HttpMethod.Head, imageUrl);
                    var response = await httpClient.SendAsync(request);
                    return response.IsSuccessStatusCode &&
                           response.Content.Headers.ContentType?.MediaType.StartsWith("image/") == true;
                }
            }
            catch
            {
                return false;
            }
        }
        [HttpGet]
        [AllowAnonymous]
        public IActionResult ReadFileImageForTiny(string filename, string filePath)
        {
            try
            {
                string blobPath = filePath;

                // Dapatkan MIME type dari filename
                var provider = new FileExtensionContentTypeProvider();
                if (!provider.TryGetContentType(filename, out var mimeType))
                {
                    mimeType = "application/octet-stream"; // fallback
                }


                try
                {
                    Stream fileStream = _fileHelper.ReadFile(blobPath);
                    return File(fileStream, mimeType);
                }
                catch (Exception azureEx)
                {
                    System.Diagnostics.Debug.WriteLine($"Azure read failed: {azureEx.Message}");
                    return Json(new { azureEx.Message });
                }

            }
            catch (Exception ex)
            {
                return StatusCode(500, $"An error occurred: {ex.Message}");
            }
        }


        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult AddEntry(DailyEntry entry)
        {
            entry.Created_by = UserId;
            entry.UserId = UserId ?? "guest";
            _entryService.AddEntry(entry);
            return Ok();
        }

        [HttpPost]
        public IActionResult UpdateEntry(DailyEntry entry)
        {
            entry.Modified_by = UserId;
            _entryService.UpdateEntry(entry);
            return Ok();
        }

        // GET: /Note/Edit/5
        [HttpGet]
        public IActionResult EditDate(int id)
        {
            var entries = _entryService.GetEntryById(id);
            
            if (entries == null) return NotFound();
            return PartialView(entries);
        }

        [HttpPost]
        [ValidateAntiForgeryToken]
        public IActionResult UpdateDate(int id, string date)
        {
            _entryService.UpdateDate(id, date, UserId);
            return Ok();
        }

        [HttpPost]
        public IActionResult DeleteEntry(int id)
        {
            _entryService.DeleteEntry(id, UserId);
            return Ok();
        }

        [HttpPost]
        public IActionResult ShareNote(ShareEmailModel model)
        {
            try
            {
                _emailHelper.SendEmail(model);
                return Json(new { success=true, message="Catatan berhasil dikirim" });
            }
            catch (Exception e)
            {
                return Json(new { success = false, message = "Catatan Gagal dikirim: "+e.Message });
            }
        }
    }
}
