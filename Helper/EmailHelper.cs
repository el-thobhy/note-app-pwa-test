namespace NoteAppPWA.Helper
{
    using System.Net;
    using System.Net.Mail;
    using Microsoft.Extensions.Configuration;
    using NoteAppPWA.Models;

    public interface IEmailHelper
    {
        void SendEmail(ShareEmailModel model);
    }

    public class EmailHelper : IEmailHelper
    {
        private readonly IConfiguration _configuration;

        public EmailHelper(IConfiguration configuration)
        {
            _configuration = configuration;
        }

        public void SendEmail(ShareEmailModel model)
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
                Body = model.BodyMail,
                IsBodyHtml = true,
            };

            mailMessage.To.Add(model.Email);

            smtpClient.Send(mailMessage);
        }
    }

}
