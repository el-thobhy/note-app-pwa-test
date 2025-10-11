namespace NoteAppPWA.Helper
{
    using Microsoft.Extensions.Configuration;
    using NoteAppPWA.Models;
    using SixLabors.ImageSharp;
    using System.Net;
    using System.Net.Mail;
    using System.Net.Mime;

    public interface IEmailHelper
    {
        Task SendEmailWithLinkedImages(ShareEmailModel model);
    }

    public class EmailHelper : IEmailHelper
    {
        private readonly IConfiguration _configuration;

        public EmailHelper(IConfiguration configuration)
        {
            _configuration = configuration;
        }
        public async Task SendEmailWithLinkedImages(ShareEmailModel model)
        {
            var emailSettings = _configuration.GetSection("EmailSettings");

            using var smtpClient = new SmtpClient(emailSettings["SmtpServer"])
            {
                Port = int.Parse(emailSettings["Port"]!),
                Credentials = new NetworkCredential(emailSettings["UserName"], emailSettings["Password"]),
                EnableSsl = true
            };

            using var mailMessage = new MailMessage
            {
                From = new MailAddress(emailSettings["FromEmail"]!),
                Subject = model.Subject,
                IsBodyHtml = true,
            };

            foreach (var mailTo in model.Email.Split(';'))
            {
                if (!string.IsNullOrEmpty(mailTo))
                    mailMessage.To.Add(mailTo);
            }

            string htmlBody = model.BodyMail;
            var doc = new HtmlAgilityPack.HtmlDocument();
            doc.LoadHtml(htmlBody);
            var imgNodes = doc.DocumentNode.SelectNodes("//img[@src]");

            var htmlView = AlternateView.CreateAlternateViewFromString(htmlBody, null, MediaTypeNames.Text.Html);

            if (imgNodes != null)
            {
                int counter = 1;
                using var httpClient = new HttpClient();

                foreach (var imgNode in imgNodes)
                {
                    var imgSrc = imgNode.GetAttributeValue("src", null);
                    if (string.IsNullOrEmpty(imgSrc)) continue;

                    try
                    {
                        byte[] imageBytes;
                        string mediaType = MediaTypeNames.Image.Jpeg;

                        // ✅ CASE 1: Base64 inline image
                        if (imgSrc.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
                        {
                            // Extract content type and base64 data
                            var match = System.Text.RegularExpressions.Regex.Match(imgSrc, @"data:(image/\w+);base64,(.*)");
                            if (match.Success)
                            {
                                mediaType = match.Groups[1].Value;
                                imageBytes = Convert.FromBase64String(match.Groups[2].Value);
                            }
                            else continue;
                        }
                        // ✅ CASE 2: HTTP or HTTPS URL
                        else if (imgSrc.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                        {
                            imageBytes = await httpClient.GetByteArrayAsync(imgSrc);

                            // Try to detect MIME type from extension
                            string ext = Path.GetExtension(imgSrc).ToLower();
                            mediaType = ext switch
                            {
                                ".png" => MediaTypeNames.Image.Jpeg.Replace("jpeg", "png"),
                                ".gif" => MediaTypeNames.Image.Gif,
                                _ => MediaTypeNames.Image.Jpeg
                            };
                        }
                        else
                        {
                            continue; // Skip if unknown src
                        }

                        // Create stream from image bytes
                        var imageStream = new MemoryStream(imageBytes);

                        // Create a unique CID
                        string cid = "img" + counter++;
                        var linkedImage = new LinkedResource(imageStream, mediaType)
                        {
                            ContentId = cid,
                            TransferEncoding = TransferEncoding.Base64
                        };

                        // Add the resource to the HTML view
                        htmlView.LinkedResources.Add(linkedImage);

                        // Replace the image source with cid reference
                        imgNode.SetAttributeValue("src", $"cid:{cid}");
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"⚠️ Failed to process image {imgSrc}: {ex.Message}");
                    }
                }

                // Update HTML after replacing src with cid:
                htmlBody = doc.DocumentNode.OuterHtml;
                htmlView = AlternateView.CreateAlternateViewFromString(htmlBody, null, MediaTypeNames.Text.Html);
            }

            mailMessage.AlternateViews.Add(htmlView);

            await smtpClient.SendMailAsync(mailMessage);
        }

    }
}